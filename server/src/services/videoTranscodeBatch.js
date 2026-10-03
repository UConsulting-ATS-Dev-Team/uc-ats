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

import fs from 'node:fs';
import path from 'node:path';
import {
  DECISION,
  MAPPING_STATUS,
  TRANSCODED_FROM_KEY,
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

const METADATA_FIELDS = 'id, name, mimeType, size, parents, appProperties, trashed';

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
 */
async function repointAll({ applications, originalFileId, newFileId, repoint, fields }) {
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
  fileId, applications, apply = false, probe = false, scratchDir, tools = {}, drive, repoint,
}) {
  const result = (status, reason, fields = {}) => ({
    fileId,
    status,
    reason,
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
  // That copy was verified before upload, so use it rather than make another.
  const existing = await driveStep('lookup', () => drive.listFilesByAppProperty({
    folderId, key: TRANSCODED_FROM_KEY, value: fileId,
  }));
  if (existing.length) {
    const copy = existing[0];
    const fields = { originalBytes, newBytes: copy.size != null ? Number(copy.size) : null, durationMs: 0, action: 'reuse' };
    if (!apply) {
      return result(MAPPING_STATUS.PLANNED, `web copy ${copy.id} already uploaded; would repoint to it`, { ...known, ...fields, newFileId: copy.id });
    }
    const rows = await repointAll({ applications, originalFileId: fileId, newFileId: copy.id, repoint, fields });
    return summarize(rows, { ...known, ...fields, newFileId: copy.id, reason: 'reused a web copy from an earlier run' });
  }

  if (!apply && !probe) {
    const guess = meta.mimeType === 'video/quicktime'
      ? 'QuickTime; would transcode or remux'
      : `${meta.mimeType}; needs a probe to decide (--probe)`;
    return result(MAPPING_STATUS.PLANNED, guess, known);
  }

  fs.mkdirSync(scratchDir, { recursive: true });
  const safeId = fileId.replace(/[^\w-]/g, '_');
  const sourcePath = path.join(scratchDir, `${safeId}.source`);
  const outputPath = path.join(scratchDir, `${safeId}${WEB_SUFFIX}`);
  try {
    await driveStep('download', () => drive.downloadFile(fileId, sourcePath));

    let decision;
    try {
      decision = decideTranscode(await inspectVideo(sourcePath));
    } catch (error) {
      return result(MAPPING_STATUS.FAILED, `ffprobe could not read it: ${error.message}`, known);
    }
    const action = decision.action;
    if (action === DECISION.SKIP) return result(MAPPING_STATUS.SKIPPED, decision.reason, { ...known, action });
    if (!apply) return result(MAPPING_STATUS.PLANNED, `would ${action}: ${decision.reason}`, { ...known, action });

    let durationMs;
    try {
      ({ durationMs } = await transcodeVideo({
        input: sourcePath, output: outputPath, decision, canTonemap: tools.canTonemap,
      }));
    } catch (error) {
      return result(MAPPING_STATUS.FAILED, `ffmpeg failed: ${error.message}`, { ...known, action });
    }

    const check = await verifyWebCopy(outputPath, { sourceDurationSec: decision.info.durationSec });
    if (check.problems.length) {
      return result(MAPPING_STATUS.FAILED, `copy failed its check: ${check.problems.join('; ')}`, { ...known, action, durationMs });
    }
    const newBytes = (await fs.promises.stat(outputPath)).size;

    const uploaded = await driveStep('upload', () => drive.uploadFile({
      name: webCopyName(meta.name),
      folderId,
      body: fs.createReadStream(outputPath),
      mimeType: 'video/mp4',
      appProperties: { [TRANSCODED_FROM_KEY]: fileId },
    }));

    const fields = { originalBytes, newBytes, durationMs, action };
    const rows = await repointAll({ applications, originalFileId: fileId, newFileId: uploaded.id, repoint, fields });
    return summarize(rows, { ...known, ...fields, newFileId: uploaded.id, reason: decision.reason });
  } finally {
    await fs.promises.rm(sourcePath, { force: true });
    await fs.promises.rm(outputPath, { force: true });
  }
}

function summarize(rows, fields) {
  const failed = rows.filter((row) => row.status === MAPPING_STATUS.FAILED);
  return {
    ...fields,
    fileId: rows[0]?.originalFileId,
    status: failed.length ? MAPPING_STATUS.FAILED : MAPPING_STATUS.REPOINTED,
    reason: failed.length ? failed.map((row) => row.reason).join('; ') : fields.reason,
    rows,
  };
}

/**
 * Runs `processOne` over `groups`, `concurrency` at a time, in order. Stops taking
 * new work after `maxDriveFailures` Drive failures in a row (a revoked share or an
 * exhausted quota fails every file the same way); work already started finishes.
 * `onResult(group, result | null, error | null)` is called as each one ends.
 */
export async function runPool({ groups, concurrency = 2, maxDriveFailures = 3, processOne, onResult }) {
  let next = 0;
  let consecutiveDriveFailures = 0;
  let stopReason = null;
  const done = { processed: 0, notStarted: 0 };

  const worker = async () => {
    while (!stopReason && next < groups.length) {
      const group = groups[next++];
      let outcome = null;
      let failure = null;
      try {
        outcome = await processOne(group);
        consecutiveDriveFailures = 0;
      } catch (error) {
        failure = error;
        if (error instanceof DriveStepError) {
          consecutiveDriveFailures += 1;
          if (consecutiveDriveFailures >= maxDriveFailures && !stopReason) {
            stopReason = `${consecutiveDriveFailures} Drive failures in a row (last: ${error.message})`;
          }
        } else {
          consecutiveDriveFailures = 0;
        }
      }
      done.processed += 1;
      await onResult(group, outcome, failure);
    }
  };

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, groups.length)) }, worker));
  done.notStarted = groups.length - next;
  return { ...done, stopReason };
}
