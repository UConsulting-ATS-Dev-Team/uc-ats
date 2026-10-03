#!/usr/bin/env node
// Give every application video in a cycle a web copy: an H.264/AAC MP4 with its
// index first, at most 720p and 30 fps, uploaded next to the original as
// `<name>.web.mp4`, and point the application's videoUrl at it. Graders get a
// first frame without the browser reading the whole file, and each view moves
// about a third of the bytes. Originals are never modified or deleted.
//
//   cd server && node scripts/transcode-videos.js                     # dry run, metadata only
//   cd server && node scripts/transcode-videos.js --probe             # dry run, download and probe each
//   cd server && node scripts/transcode-videos.js --apply --limit=3   # do three
//   cd server && node scripts/transcode-videos.js --apply             # do the rest
//   cd server && node scripts/transcode-videos.js --revert=scripts/output/video-transcode-<ts>.jsonl [--apply]
//
// Options:
//   --cycle=<id>          cycle to work on (default: the admin-active cycle)
//   --only=<appId>        just this application, whatever its cycle
//   --limit=N             at most N Drive files that still need a copy this run
//                         (ones already done are passed over, not counted)
//   --concurrency=N       files at once, 1-3 (default 2)
//   --max-drive-failures=N  stop after N Drive failures in a row (default 3)
//   --scratch=<dir>       where downloads and copies go while working
//                         (default: the OS temp dir; each file is deleted when done)
//
// Re-running is safe: a videoUrl already on a web copy is skipped, and a copy an
// interrupted run uploaded but never pointed at is reused instead of redone.
// Every run appends one row per application to
// scripts/output/video-transcode-<timestamp>.jsonl; --revert reads that file and
// puts each original URL back, but only where videoUrl still holds the copy.
//
// What a video needs, and the ffmpeg command, live in
// src/services/videoTranscode.js; the per-file steps in videoTranscodeBatch.js.
// This file is arguments, the database and printing.

import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
loadEnv({ path: path.join(__dirname, '..', '.env') });

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const intOption = (name, fallback, { min = 1, max = Infinity } = {}) => {
  const raw = option(name);
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    console.error(`--${name} must be a whole number from ${min} to ${max === Infinity ? 'up' : max}`);
    process.exit(1);
  }
  return n;
};

const apply = flag('apply');
const probe = flag('probe');
const revertPath = option('revert');
const cycleOption = option('cycle');
const only = option('only');
const limit = intOption('limit', Infinity);
const concurrency = intOption('concurrency', 2, { max: 3 });
const maxDriveFailures = intOption('max-drive-failures', 3);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const scratchDir = path.resolve(option('scratch') || path.join(os.tmpdir(), `uc-ats-video-transcode-${stamp}`));

const known = new Set(['apply', 'probe', 'revert', 'cycle', 'only', 'limit', 'concurrency', 'max-drive-failures', 'scratch']);
const unknown = args.filter((a) => !known.has(a.replace(/^--/, '').split('=')[0]));
if (unknown.length) {
  console.error(`Unknown argument(s): ${unknown.join(' ')}. See the top of this file for usage.`);
  process.exit(1);
}

const { default: prisma } = await import('../src/prismaClient.js');
const transcode = await import('../src/services/videoTranscode.js');
const { MAPPING_STATUS, createMappingWriter, formatBytes } = transcode;

const mappingPath = path.join(__dirname, 'output', `video-transcode${revertPath ? '-revert' : ''}-${stamp}.jsonl`);

/**
 * One application's videoUrl from `fromUrl` to `toUrl`, in its own transaction,
 * and only if it still reads `fromUrl` - so a URL someone changed since the run
 * read it is left alone and reported instead of overwritten.
 */
async function repoint({ applicationId, fromUrl, toUrl }) {
  await prisma.$transaction(async (tx) => {
    const { count } = await tx.application.updateMany({
      where: { id: applicationId, videoUrl: fromUrl },
      data: { videoUrl: toUrl },
    });
    if (count !== 1) throw new Error('videoUrl changed since this run read it; left as is');
  });
}

async function revert() {
  const rows = transcode.readMappingRows(path.resolve(revertPath));
  const plan = transcode.planRevert(rows);
  const writer = apply ? createMappingWriter(mappingPath) : null;
  console.log(`Mapping file: ${path.resolve(revertPath)}`);
  console.log(`Repointed applications in it: ${plan.length}`);
  console.log(apply ? 'Reverting.\n' : 'Dry run: nothing will be written. Add --apply to revert.\n');

  const counts = { reverted: 0, skipped: 0 };
  for (const item of plan) {
    const current = await prisma.application.findUnique({ where: { id: item.applicationId }, select: { videoUrl: true } });
    let skip = null;
    if (!current) skip = 'application no longer exists';
    else if (current.videoUrl === item.originalUrl) skip = 'already on the original';
    else if (current.videoUrl !== item.newUrl) skip = `videoUrl is now ${current.videoUrl}, not the web copy; left as is`;
    if (skip) {
      counts.skipped += 1;
      console.log(`  skip    ${item.applicationId}: ${skip}`);
      continue;
    }
    if (!apply) {
      console.log(`  would revert ${item.applicationId}: ${item.newFileId} -> ${item.originalFileId}`);
      continue;
    }
    try {
      await repoint({ applicationId: item.applicationId, fromUrl: item.newUrl, toUrl: item.originalUrl });
      counts.reverted += 1;
      writer.append({ ...item, status: MAPPING_STATUS.REVERTED });
      console.log(`  reverted ${item.applicationId}: ${item.newFileId} -> ${item.originalFileId}`);
    } catch (error) {
      counts.skipped += 1;
      console.log(`  skip    ${item.applicationId}: ${error.message}`);
    }
  }
  console.log(`\nReverted: ${counts.reverted}   Skipped: ${counts.skipped}`);
  if (writer) console.log(`Log: ${writer.path}`);
  console.log('The web copies stay in Drive; delete them by hand if they are not wanted.');
}

async function run() {
  const { groupByVideoFile, processVideoFile, runPool } = await import('../src/services/videoTranscodeBatch.js');
  const drive = await import('../src/services/google/drive.js');
  const { resolveAdminCycle } = await import('../src/services/activeCycle.js');

  let tools = {};
  if (apply || probe) {
    tools = await transcode.checkTools();
    if (!tools.canTonemap) {
      console.log('Note: this ffmpeg has no zscale filter, so HDR (iPhone) video will be converted without tone mapping and may look washed out.');
    }
  }

  let cycle = null;
  if (!only) {
    cycle = cycleOption
      ? await prisma.recruitingCycle.findUnique({ where: { id: cycleOption } })
      : await resolveAdminCycle(prisma);
    if (!cycle) {
      console.error(cycleOption ? `No cycle with id ${cycleOption}.` : 'No active cycle; pass --cycle=<id>.');
      process.exit(1);
    }
  }

  const applications = await prisma.application.findMany({
    where: only ? { id: only } : { cycleId: cycle.id, videoUrl: { not: null } },
    select: { id: true, videoUrl: true, firstName: true, lastName: true },
    orderBy: { createdAt: 'asc' },
  });
  if (only && !applications.length) {
    console.error(`No application with id ${only}.`);
    process.exit(1);
  }
  const withVideo = applications.filter((a) => a.videoUrl);
  const { groups, unparsed } = groupByVideoFile(withVideo);

  console.log(cycle ? `Cycle: ${cycle.name} (${cycle.id})` : `Application: ${only}`);
  console.log(`Applications with a video: ${withVideo.length} (${groups.length} Drive files)`);
  if (limit < groups.length) console.log(`This run: up to ${limit} that still need a copy (--limit)`);
  console.log(apply ? `Applying, ${concurrency} at a time. Scratch: ${scratchDir}`
    : `Dry run: nothing is uploaded or written to the database. ${probe ? 'Downloading to probe each file.' : 'Metadata only; add --probe to download and decide for real.'}`);
  console.log(`Mapping: ${mappingPath}\n`);

  const writer = createMappingWriter(mappingPath);
  const label = (a) => `${a.id} (${[a.firstName, a.lastName].filter(Boolean).join(' ') || 'no name'})`;
  for (const { application, reason } of unparsed) {
    writer.append({ applicationId: application.id, originalUrl: application.videoUrl, status: MAPPING_STATUS.SKIPPED, reason });
    console.log(`  skip    ${label(application)}: ${reason} (${application.videoUrl})`);
  }
  if (only && !withVideo.length) console.log(`  skip    ${only}: no videoUrl`);

  const totals = { originalBytes: 0, newBytes: 0 };
  const counts = {};
  let index = 0;
  const pool = await runPool({
    groups,
    concurrency,
    maxDriveFailures,
    limit,
    processOne: (group) => processVideoFile({
      fileId: group.fileId, applications: group.applications, apply, probe, scratchDir, tools, drive, repoint,
      // The rollback record goes to disk before each database write.
      record: (row) => writer.append(row),
    }),
    onResult: (group, result, error) => {
      index += 1;
      const who = group.applications.map(label).join(', ');
      const prefix = `[${index}/${groups.length}]`;
      if (error) {
        counts.failed = (counts.failed || 0) + group.applications.length;
        for (const a of group.applications) {
          writer.append({ applicationId: a.id, originalFileId: group.fileId, originalUrl: a.videoUrl, status: MAPPING_STATUS.FAILED, reason: error.message });
        }
        console.log(`${prefix} FAILED  ${who}: ${error.message}`);
        return;
      }
      for (const row of result.rows) {
        writer.append(row);
        counts[row.status] = (counts[row.status] || 0) + 1;
      }
      const name = result.name ? `${result.name} ` : '';
      if (result.status === MAPPING_STATUS.REPOINTED || (result.status === MAPPING_STATUS.FAILED && result.newFileId)) {
        totals.originalBytes += result.originalBytes || 0;
        totals.newBytes += result.newBytes || 0;
        const ratio = result.originalBytes ? ` (${Math.round((100 * result.newBytes) / result.originalBytes)}%)` : '';
        const took = result.durationMs ? ` in ${(result.durationMs / 1000).toFixed(0)}s` : '';
        console.log(`${prefix} ${result.status.padEnd(9)} ${who}: ${name}${formatBytes(result.originalBytes)} -> ${formatBytes(result.newBytes)}${ratio}${took} [${result.action}] ${result.reason}`);
      } else {
        console.log(`${prefix} ${result.status.padEnd(9)} ${who}: ${name}${formatBytes(result.originalBytes)} - ${result.reason}`);
      }
    },
  });

  console.log('');
  for (const [status, n] of Object.entries(counts)) console.log(`${status}: ${n}`);
  if (totals.originalBytes) {
    console.log(`Bytes for repointed videos: ${formatBytes(totals.originalBytes)} -> ${formatBytes(totals.newBytes)} (${Math.round((100 * totals.newBytes) / totals.originalBytes)}%)`);
  }
  if (!pool.stopReason && pool.notStarted) {
    console.log(`\n${pool.notStarted} file(s) not looked at (--limit reached). Re-run to continue; finished files are passed over.`);
  }
  if (pool.stopReason) {
    console.log(`\nSTOPPED: ${pool.stopReason}. ${pool.notStarted} file(s) not started. Fix Drive access and re-run; finished files are skipped.`);
    process.exitCode = 2;
  }
  if (counts.failed) process.exitCode = process.exitCode || 1;
  console.log(`Mapping: ${writer.path}`);
}

try {
  if (revertPath) await revert();
  else await run();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
