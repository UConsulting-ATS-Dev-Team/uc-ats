// One pass of "give every application video a web copy", file by file.
//
// The steps for one Drive file - look it up, download, decide, transcode, check,
// upload next to the original, repoint - and the worker pool that runs them a few
// at a time. Drive is passed in and the database write is a `repoint` callback,
// so this never touches either directly and the whole flow is testable with
// stubs. scripts/transcode-videos.js supplies both and does the printing.
//
// Originals are never modified or deleted: a web copy is a new file, and the only
// write anywhere else is the application's videoUrl.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import {
  DECISION,
  MAPPING_STATUS,
  TRANSCODED_FROM_KEY,
  TRANSCODED_FROM_MD5_KEY,
  WEB_SUFFIX,
  decideTranscode,
  inspectVideo,
  isWebCopyName,
  parseFileUrl,
  replaceFileId,
  transcodeVideo,
  verifyWebCopy,
  webCopyName,
} from './videoTranscode.js';

const METADATA_FIELDS = 'id, name, mimeType, size, md5Checksum, parents, appProperties, trashed';
const COPY_FIELDS = 'id, name, mimeType, size, appProperties';

/** Marks an error as Drive's, so the pool can count Drive failures apart from ffmpeg's. */
export class DriveStepError extends Error {
  constructor(step, cause) {
    super(`Drive ${step} failed: ${cause?.message || cause}`);
    this.name = 'DriveStepError';
    this.step = step;
    this.cause = cause;
  }
}

const driveStep = async (step, fn) => {
  try {
    return await fn();
  } catch (error) {
    throw new DriveStepError(step, error);
  }
};

/**
 * Applications grouped by the Drive file their videoUrl points at, so a file two
 * applications share is transcoded once. Values that are not /api/files URLs come
 * back in `unparsed`, each with its reason, rather than being dropped.
 */
export function groupByVideoFile(applications) {
  const groups = new Map();
  const unparsed = [];
  for (const application of applications) {
    const parsed = parseFileUrl(application.videoUrl);
    if (!parsed) {
      unparsed.push({ application, reason: 'videoUrl is not an /api/files/<id> link' });
      continue;
    }
    if (!groups.has(parsed.fileId)) groups.set(parsed.fileId, { fileId: parsed.fileId, applications: [] });
    groups.get(parsed.fileId).applications.push(application);
  }
  return { groups: [...groups.values()], unparsed };
}

const rowsFor = (applications, fields) => applications.map((application) => ({
  applicationId: application.id,
  originalUrl: application.videoUrl,
  ...fields,
}));

/**
 * Repoints each application from its current videoUrl to the same URL with
 * `newFileId`. One `repoint` call per application, so one failure does not undo
 * the others; each comes back as its own row.
 *
 * `record` is handed a `repointing` row before each write. If it cannot be
 * recorded the write is not made: a repoint with no row to revert from is the
 * one thing a run must not leave behind.
 */
async function repointAll({ applications, originalFileId, newFileId, repoint, record, fields }) {
  const rows = [];
  for (const application of applications) {
    const newUrl = replaceFileId(application.videoUrl, newFileId);
    const base = {
      applicationId: application.id,
      originalFileId,
      originalUrl: application.videoUrl,
      newFileId,
      newUrl,
      ...fields,
    };
    try {
      await record?.({ ...base, status: MAPPING_STATUS.REPOINTING });
    } catch (error) {
      rows.push({ ...base, status: MAPPING_STATUS.FAILED, reason: `not repointed: could not write the rollback record (${error.message})` });
      continue;
    }
    try {
      await repoint({ applicationId: application.id, fromUrl: application.videoUrl, toUrl: newUrl });
      rows.push({ ...base, status: MAPPING_STATUS.REPOINTED });
    } catch (error) {
      rows.push({ ...base, status: MAPPING_STATUS.FAILED, reason: `repoint failed: ${error.message}` });
    }
  }
  return rows;
}

/**
 * Everything for one Drive file. Resolves with `{ status, reason, rows, ... }`;
 * `rows` has one mapping row per application. Throws only a DriveStepError (so
 * the pool can count it) - any other failure is a `failed` result.
 *
 * `apply` false never uploads or repoints. `probe` makes a dry run download and
 * probe anyway, to report the real decision rather than a guess from metadata.
 */
export async function processVideoFile({
  fileId, applications, apply = false, probe = false, scratchDir, tools = {}, drive, repoint, record,
}) {
  const result = (status, reason, fields = {}) => ({
    fileId,
    status,
    reason,
    // A skip or a dry-run answer finished every Drive call it needed. A failure
    // (ffprobe, ffmpeg, the copy's check) stopped partway, so it shows nothing
    // about Drive either way.
    driveConfirmed: status !== MAPPING_STATUS.FAILED,
    ...fields,
    rows: fields.rows || rowsFor(applications, {
      originalFileId: fileId,
      originalBytes: fields.originalBytes ?? null,
      status,
      reason,
      action: fields.action,
    }),
  });

  const meta = await driveStep('metadata', () => drive.getFileMetadata(fileId, { fields: METADATA_FIELDS }));
  const originalBytes = meta?.size != null ? Number(meta.size) : null;
  const name = meta?.name || fileId;
  const known = { originalBytes, name };

  if (meta?.trashed) return result(MAPPING_STATUS.SKIPPED, 'original is in the Drive trash', known);
  if (isWebCopyName(meta?.name) || meta?.appProperties?.[TRANSCODED_FROM_KEY]) {
    return result(MAPPING_STATUS.SKIPPED, 'already points at a web copy', known);
  }
  if (!String(meta?.mimeType || '').startsWith('video/')) {
    return result(MAPPING_STATUS.SKIPPED, `not a video (${meta?.mimeType || 'no type'})`, known);
  }
  const folderId = meta?.parents?.[0];
  if (!folderId) {
    return result(MAPPING_STATUS.SKIPPED, 'original has no folder the service account can see', known);
  }

  // An earlier run may have uploaded a copy and then stopped before repointing.
  // Such a copy is checked like a new one (below) and reused if it passes.
  const existing = await driveStep('lookup', () => drive.listFilesByAppProperty({
    folderId, key: TRANSCODED_FROM_KEY, value: fileId, fields: COPY_FIELDS,
  }));

  if (!apply && !probe) {
    const what = meta.mimeType === 'video/quicktime'
      ? 'QuickTime; would transcode or remux'
      : `${meta.mimeType}; needs a probe to decide (--probe)`;
    return result(MAPPING_STATUS.PLANNED, `${what}${leftoverNote(existing, meta.md5Checksum)}`, known);
  }

  fs.mkdirSync(scratchDir, { recursive: true });
  const safeId = fileId.replace(/[^\w-]/g, '_');
  const sourcePath = path.join(scratchDir, `${safeId}.source`);
  const outputPath = path.join(scratchDir, `${safeId}${WEB_SUFFIX}`);
  try {
    await driveStep('download', () => drive.downloadFile(fileId, sourcePath));
    // The checksum of the bytes this run will actually transcode, not the one
    // Drive reported before the download: an original replaced in between is
    // then compared, and tagged, as what it now is.
    const sourceMd5 = await md5OfFile(sourcePath);

    let decision;
    try {
      decision = decideTranscode(await inspectVideo(sourcePath));
    } catch (error) {
      return result(MAPPING_STATUS.FAILED, `ffprobe could not read it: ${error.message}`, known);
    }
    const action = decision.action;
    const sourceDurationSec = decision.info.durationSec;
    if (action === DECISION.SKIP) return result(MAPPING_STATUS.SKIPPED, decision.reason, { ...known, action });
    if (!apply) {
      return result(MAPPING_STATUS.PLANNED, `would ${action}: ${decision.reason}${leftoverNote(existing, sourceMd5)}`, { ...known, action });
    }

    const rejected = [];
    for (const copy of existing) {
      const problems = await checkExistingCopy({ copy, drive, outputPath, sourceDurationSec, sourceMd5 });
      if (problems.length) {
        rejected.push(`${copy.id} (${problems.join('; ')})`);
        continue;
      }
      const fields = { originalBytes, newBytes: (await fs.promises.stat(outputPath)).size, durationMs: 0, action: 'reuse' };
      const rows = await repointAll({ applications, originalFileId: fileId, newFileId: copy.id, repoint, record, fields });
      return summarize(rows, { ...known, ...fields, newFileId: copy.id, reason: 'reused a web copy from an earlier run' });
    }
    const passedOver = rejected.length ? `; did not reuse ${rejected.join(', ')}` : '';

    let durationMs;
    try {
      ({ durationMs } = await transcodeVideo({
        input: sourcePath, output: outputPath, decision, canTonemap: tools.canTonemap,
      }));
    } catch (error) {
      return result(MAPPING_STATUS.FAILED, `ffmpeg failed: ${error.message}${passedOver}`, { ...known, action });
    }

    const check = await verifyWebCopy(outputPath, { sourceDurationSec });
    if (check.problems.length) {
      return result(MAPPING_STATUS.FAILED, `copy failed its check: ${check.problems.join('; ')}${passedOver}`, { ...known, action, durationMs });
    }
    const newBytes = (await fs.promises.stat(outputPath)).size;

    const uploaded = await driveStep('upload', () => drive.uploadFile({
      name: webCopyName(meta.name),
      folderId,
      body: fs.createReadStream(outputPath),
      mimeType: 'video/mp4',
      appProperties: { [TRANSCODED_FROM_KEY]: fileId, [TRANSCODED_FROM_MD5_KEY]: sourceMd5 },
    }));

    const fields = { originalBytes, newBytes, durationMs, action };
    const rows = await repointAll({ applications, originalFileId: fileId, newFileId: uploaded.id, repoint, record, fields });
    return summarize(rows, { ...known, ...fields, newFileId: uploaded.id, reason: `${decision.reason}${passedOver}` });
  } finally {
    await fs.promises.rm(sourcePath, { force: true });
    await fs.promises.rm(outputPath, { force: true });
  }
}

const md5OfFile = async (filePath) => {
  const hash = crypto.createHash('md5');
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest('hex');
};

/**
 * Why a leftover copy's tag rules it out, or null if the tag allows a reuse: it
 * must be an MP4 tagged with the checksum of the original as it is now (an
 * original replaced in place keeps its id).
 */
function tagProblem(copy, sourceMd5) {
  if (copy.mimeType && copy.mimeType !== 'video/mp4') return `type is ${copy.mimeType}`;
  const madeFrom = copy.appProperties?.[TRANSCODED_FROM_MD5_KEY];
  if (!sourceMd5 || !madeFrom) return 'cannot tell which version of the original it was made from';
  if (madeFrom !== sourceMd5) return 'made from another version of the original';
  return null;
}

/**
 * What a dry run can say about leftover copies without downloading them: which
 * one a real run would check, or that none can be reused. `sourceMd5` is Drive's
 * reported checksum on a metadata-only run, so this is what `--apply` would find
 * unless the original changes first.
 */
function leftoverNote(existing, sourceMd5) {
  if (!existing.length) return '';
  const candidate = existing.find((copy) => !tagProblem(copy, sourceMd5));
  return candidate
    ? `; leftover web copy ${candidate.id} matches this original, would reuse it if it passes its check`
    : `; leftover web ${existing.length === 1 ? 'copy' : 'copies'} ${existing.map((copy) => `${copy.id} (${tagProblem(copy, sourceMd5)})`).join(', ')} would not be reused`;
}

/**
 * Why an earlier run's copy cannot be reused, or [] if it can: its tag must
 * allow it (tagProblem), and it must pass the same check as a fresh copy, at the
 * source's length. Anyone with folder access could have replaced or retagged it
 * since. Downloads it to `outputPath`, which the caller overwrites or removes.
 */
async function checkExistingCopy({ copy, drive, outputPath, sourceDurationSec, sourceMd5 }) {
  const tag = tagProblem(copy, sourceMd5);
  if (tag) return [tag];
  await driveStep('download', () => drive.downloadFile(copy.id, outputPath));
  try {
    return (await verifyWebCopy(outputPath, { sourceDurationSec })).problems;
  } catch (error) {
    return [`ffprobe could not read it: ${error.message}`];
  }
}

function summarize(rows, fields) {
  const failed = rows.filter((row) => row.status === MAPPING_STATUS.FAILED);
  return {
    ...fields,
    fileId: rows[0]?.originalFileId,
    status: failed.length ? MAPPING_STATUS.FAILED : MAPPING_STATUS.REPOINTED,
    // The upload (or the reused copy's download) worked, whatever the database said.
    driveConfirmed: true,
    reason: failed.length ? failed.map((row) => row.reason).join('; ') : fields.reason,
    rows,
  };
}

/**
 * Runs `processOne` over `groups`, `concurrency` at a time, in order. Stops taking
 * new work after `maxDriveFailures` Drive failures with no file finishing its
 * Drive calls in between (a revoked share or an exhausted quota fails every file the
 * same way); work already started finishes. A result counts as finishing its
 * Drive calls when it carries `driveConfirmed`.
 * `onResult(group, result | null, error | null)` is called as each one ends.
 *
 * `limit` caps the files that count toward it, as `countsTowardLimit(result,
 * error)` decides once each ends, not the files looked at. So with the default,
 * a file skipped because it needs nothing does not use the limit up, and a
 * second `--limit=3` run moves on to the next three instead of re-reading the
 * first. A file in flight holds a place until it ends, so no more than `limit`
 * are ever worked on.
 */
export async function runPool({
  groups, concurrency = 2, maxDriveFailures = 3, limit = Infinity,
  countsTowardLimit = (result) => result?.status !== MAPPING_STATUS.SKIPPED,
  processOne, onResult,
}) {
  let next = 0;
  let consecutiveDriveFailures = 0;
  let stopReason = null;
  let counted = 0;
  let inFlight = 0;
  let waiting = [];
  const wake = () => { const resolvers = waiting; waiting = []; resolvers.forEach((resolve) => resolve()); };
  const done = { processed: 0, notStarted: 0 };

  const worker = async () => {
    while (!stopReason && next < groups.length && counted < limit) {
      if (counted + inFlight >= limit) {
        // Every remaining place is held by a file in flight. One of them may
        // turn out to be a skip and hand its place back, so wait and look again.
        await new Promise((resolve) => waiting.push(resolve));
        continue;
      }
      inFlight += 1;
      const group = groups[next++];
      let outcome = null;
      let failure = null;
      try {
        outcome = await processOne(group);
        // Only a file that finished every Drive call it needed (a skip, a dry-run
        // answer, a repoint) shows Drive is working again. An ffmpeg or check
        // failure between two Drive errors says nothing about Drive, so it
        // neither counts nor resets.
        if (outcome?.driveConfirmed) consecutiveDriveFailures = 0;
      } catch (error) {
        failure = error;
        if (error instanceof DriveStepError) {
          consecutiveDriveFailures += 1;
          if (consecutiveDriveFailures >= maxDriveFailures && !stopReason) {
            stopReason = `${consecutiveDriveFailures} Drive failures in a row (last: ${error.message})`;
          }
        }
      }
      inFlight -= 1;
      if (countsTowardLimit(outcome, failure)) counted += 1;
      wake();
      done.processed += 1;
      await onResult(group, outcome, failure);
    }
    wake();
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, groups.length)) }, worker));
  done.notStarted = groups.length - next;
  return { ...done, stopReason };
}
