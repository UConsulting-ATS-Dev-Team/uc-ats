// Turning an applicant's video into one a browser can start playing at once.
//
// Most grading videos are iPhone .mov files: HEVC, often 4K or 1080p at 60 fps,
// with the index (the `moov` box) written after the footage. A <video> element
// cannot show a frame or seek until it has that index, so it reads to the end of
// the file first, through Render, before anything happens. A web copy fixes both
// problems at once: H.264/AAC MP4 with the index first (`+faststart`), at most
// 720p, at most 30 fps.
//
// This module owns how: reading a file's streams and box order, deciding whether
// it needs work, building the ffmpeg command, checking the result, and the mapping
// file a run leaves behind. Which applications to touch, Drive and the database
// belong to the caller (scripts/transcode-videos.js).

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** The web copy's ceiling: 720p in whichever orientation the video is shown. */
export const MAX_LONG_EDGE = 1280;
export const MAX_SHORT_EDGE = 720;
export const MAX_FPS = 30;
export const CRF = 23;
/** A keyframe every 2 s at 30 fps, so a seek lands on a frame quickly. */
export const GOP_FRAMES = 60;
export const AUDIO_BITRATE = '128k';
/** Name suffix of every web copy, and how a re-run recognises one. */
export const WEB_SUFFIX = '.web.mp4';
/** appProperties key on a web copy, holding the original's Drive id. */
export const TRANSCODED_FROM_KEY = 'transcodedFrom';
// The original's md5Checksum when the copy was made. An original replaced in
// place keeps its id, so the id alone cannot say a leftover copy is current.
export const TRANSCODED_FROM_MD5_KEY = 'transcodedFromMd5';

// A little slack over 30, because variable-frame-rate phone video reports
// averages like 30.02.
const FPS_TOLERANCE = 0.5;
const HDR_TRANSFERS = new Set(['arib-std-b67', 'smpte2084']);

export const DECISION = Object.freeze({
  SKIP: 'skip',
  REMUX: 'remux',
  TRANSCODE: 'transcode',
});

// --- Names and URLs -----------------------------------------------------------

/** `IMG_1234.MOV` -> `IMG_1234.web.mp4`. */
export function webCopyName(originalName) {
  const base = path.basename(String(originalName || 'video'));
  const ext = path.extname(base);
  return `${ext ? base.slice(0, -ext.length) : base}${WEB_SUFFIX}`;
}

export const isWebCopyName = (name) => typeof name === 'string' && name.toLowerCase().endsWith(WEB_SUFFIX);

const FILE_URL = /^((?:https?:\/\/[^/]+)?\/api\/files\/)([^/?#]+)(\/[^?#]*)?$/;

/**
 * An application's videoUrl split into what is kept and the Drive id that changes:
 * `/api/files/<id>/pdf`, optionally with an absolute origin. Null when the value is
 * not one of ours (a raw Drive link, say), so the caller can report it.
 */
export function parseFileUrl(url) {
  const match = typeof url === 'string' ? FILE_URL.exec(url.trim()) : null;
  if (!match) return null;
  return { prefix: match[1], fileId: decodeURIComponent(match[2]), suffix: match[3] || '' };
}

/** The same URL with another Drive file in it. */
export const replaceFileId = (url, newFileId) => {
  const parsed = parseFileUrl(url);
  if (!parsed) throw new Error(`Not an /api/files URL: ${url}`);
  return `${parsed.prefix}${encodeURIComponent(newFileId)}${parsed.suffix}`;
};

// --- Reading a file -----------------------------------------------------------

/**
 * The top-level MP4/QuickTime boxes in file order, e.g. ['ftyp', 'mdat', 'moov'].
 * Reads only the 8-16 byte headers, so it costs a few reads however big the file.
 */
export async function readTopLevelBoxes(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const header = Buffer.alloc(16);
    const boxes = [];
    let offset = 0;
    while (offset + 8 <= size && boxes.length < 1000) {
      await handle.read(header, 0, 16, offset);
      let boxSize = header.readUInt32BE(0);
      const type = header.toString('latin1', 4, 8);
      if (boxSize === 1) boxSize = Number(header.readBigUInt64BE(8));
      else if (boxSize === 0) boxSize = size - offset;
      if (boxSize < 8) break; // corrupt; stop rather than loop
      boxes.push(type);
      offset += boxSize;
    }
    return boxes;
  } finally {
    await handle.close();
  }
}

/** True when the index comes before the footage, so playback can start early. */
export function isFaststart(boxes) {
  const moov = boxes.indexOf('moov');
  const mdat = boxes.indexOf('mdat');
  return moov !== -1 && (mdat === -1 || moov < mdat);
}

const parseRate = (rate) => {
  const [num, den] = String(rate || '').split('/').map(Number);
  return num > 0 && den > 0 ? num / den : null;
};

const rotationOf = (stream) => {
  const fromSideData = stream?.side_data_list?.find((d) => d.rotation != null)?.rotation;
  const raw = fromSideData ?? stream?.tags?.rotate ?? 0;
  return ((Math.round(Number(raw) || 0) % 360) + 360) % 360;
};

/**
 * The facts the decision needs, from `ffprobe -show_format -show_streams` JSON.
 * Width and height are as displayed: a portrait phone video stored sideways with
 * a 90 degree rotation is reported as portrait, because ffmpeg rotates it before
 * scaling.
 */
export function summarizeProbe(probe) {
  const streams = probe?.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === 'audio');
  const rotation = video ? rotationOf(video) : 0;
  const sideways = rotation === 90 || rotation === 270;
  return {
    brand: (probe?.format?.tags?.major_brand || '').trim(),
    durationSec: Number(probe?.format?.duration) || null,
    video: video ? {
      codec: video.codec_name,
      pixFmt: video.pix_fmt,
      width: sideways ? video.height : video.width,
      height: sideways ? video.width : video.height,
      fps: parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate),
      hdr: HDR_TRANSFERS.has(video.color_transfer),
    } : null,
    audio: audio ? { codec: audio.codec_name } : null,
  };
}

/** The displayed size scaled down to fit 720p, never up; both sides even. */
export function targetSize({ width, height }) {
  const long = Math.max(width, height);
  const short = Math.min(width, height);
  const scale = Math.min(1, MAX_LONG_EDGE / long, MAX_SHORT_EDGE / short);
  const even = (n) => Math.max(2, Math.round(n / 2) * 2);
  return scale === 1 && width % 2 === 0 && height % 2 === 0
    ? { width, height }
    : { width: even(width * scale), height: even(height * scale) };
}

const withinSize = ({ width, height }) =>
  Math.max(width, height) <= MAX_LONG_EDGE && Math.min(width, height) <= MAX_SHORT_EDGE;

/**
 * What to do with one video, given its ffprobe JSON and top-level box order.
 *
 * - `skip`: already an H.264/AAC MP4 at or under 720p and 30 fps with its index
 *   first. A copy would only cost quality.
 * - `remux`: the streams are already fine but the container is not (QuickTime, or
 *   index last). Copying the streams into a faststart MP4 is lossless and quick.
 * - `transcode`: anything else - HEVC, 1080p and up, 60 fps, 10-bit, HDR.
 *
 * `reason` is written to the log and the mapping file as-is.
 */
export function decideTranscode({ probe, boxes }) {
  const info = summarizeProbe(probe);
  const { video, audio } = info;
  if (!video || !video.width || !video.height) {
    return { action: DECISION.SKIP, reason: 'no video stream ffprobe can read', info };
  }

  const problems = [];
  if (video.codec !== 'h264') problems.push(`video is ${video.codec}`);
  if (video.pixFmt !== 'yuv420p' && video.pixFmt !== 'yuvj420p') problems.push(`pixel format ${video.pixFmt}`);
  if (video.hdr) problems.push('HDR');
  if (!withinSize(video)) problems.push(`${video.width}x${video.height} is over 720p`);
  if (video.fps && video.fps > MAX_FPS + FPS_TOLERANCE) problems.push(`${Math.round(video.fps)} fps`);
  if (audio && audio.codec !== 'aac') problems.push(`audio is ${audio.codec}`);

  const target = targetSize(video);
  if (problems.length) {
    return { action: DECISION.TRANSCODE, reason: problems.join(', '), target, info };
  }

  const containerProblems = [];
  if (info.brand === 'qt') containerProblems.push('QuickTime container');
  if (!isFaststart(boxes)) containerProblems.push('index at the end');
  if (containerProblems.length) {
    return { action: DECISION.REMUX, reason: `${containerProblems.join(', ')}; streams already web-ready`, target, info };
  }

  return { action: DECISION.SKIP, reason: 'already a faststart H.264 MP4 at or under 720p', target, info };
}

// --- ffmpeg -------------------------------------------------------------------

// HDR (iPhone HLG) squeezed into 8-bit without tone mapping looks grey and flat,
// so it is mapped to SDR first. Needs ffmpeg built with zimg (`zscale`).
const TONEMAP_FILTERS = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,'
  + 'tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv';

/**
 * The ffmpeg argument list for a decision. Pure, so it is tested as data.
 * `canTonemap` says whether this ffmpeg has `zscale`; without it HDR is
 * converted without tone mapping (watchable, slightly washed out).
 */
export function buildFfmpegArgs({ input, output, decision, canTonemap = false }) {
  const head = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-i', input,
    '-map', '0:v:0', '-map', '0:a:0?',
    // Drops global metadata, which on a phone video includes where it was filmed.
    '-map_metadata', '-1', '-map_chapters', '-1'];
  const tail = ['-movflags', '+faststart', '-f', 'mp4', output];

  if (decision.action === DECISION.REMUX) {
    return [...head, '-c', 'copy', ...tail];
  }
  if (decision.action !== DECISION.TRANSCODE) {
    throw new Error(`Nothing to run for a "${decision.action}" decision`);
  }

  const { width, height } = decision.target;
  const hdr = decision.info?.video?.hdr;
  const filters = [
    ...(hdr && canTonemap ? [TONEMAP_FILTERS] : []),
    `scale=${width}:${height}:flags=lanczos`,
    'format=yuv420p',
    // Tag the result SDR BT.709. ffmpeg 8 takes colour tags from the frames, so
    // the -color_* output options alone are not written; setparams is.
    'setparams=color_primaries=bt709:color_trc=bt709:colorspace=bt709',
  ];
  return [
    ...head,
    '-vf', filters.join(','),
    '-fpsmax', String(MAX_FPS),
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(CRF),
    '-profile:v', 'high', '-g', String(GOP_FRAMES),
    '-c:a', 'aac', '-b:a', AUDIO_BITRATE,
    ...tail,
  ];
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      reject(error);
      return;
    }
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('error', reject);
    child.on('close', (code) => {
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(`${command} exited ${code}: ${stderr.trim().split('\n').slice(-5).join(' | ')}`), { stderr }));
    });
  });
}

/**
 * Confirms ffmpeg and ffprobe are on PATH and reports what this build can do.
 * Throws with an install hint otherwise, before any file is downloaded.
 */
export async function checkTools() {
  for (const tool of ['ffmpeg', 'ffprobe']) {
    try {
      await run(tool, ['-hide_banner', '-version']);
    } catch (error) {
      throw new Error(`${tool} was not found or does not run (${error.code || error.message}). `
        + 'Install it first: `brew install ffmpeg` on macOS, `apt-get install ffmpeg` on Debian/Ubuntu.');
    }
  }
  const { stdout: encoders } = await run('ffmpeg', ['-hide_banner', '-encoders']);
  if (!/\blibx264\b/.test(encoders)) {
    throw new Error('This ffmpeg has no libx264 encoder. Install a build with it (Homebrew\'s ffmpeg has it).');
  }
  const { stdout: filters } = await run('ffmpeg', ['-hide_banner', '-filters']);
  return { canTonemap: /\bzscale\b/.test(filters) };
}

export async function probeFile(filePath) {
  const { stdout } = await run('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', filePath]);
  return JSON.parse(stdout);
}

/** Probe and box order together: everything `decideTranscode` needs. */
export async function inspectVideo(filePath) {
  const [probe, boxes] = await Promise.all([probeFile(filePath), readTopLevelBoxes(filePath)]);
  return { probe, boxes };
}

/** Runs ffmpeg for a remux or transcode decision. Resolves with how long it took. */
export async function transcodeVideo({ input, output, decision, canTonemap }) {
  const started = Date.now();
  await run('ffmpeg', buildFfmpegArgs({ input, output, decision, canTonemap }));
  return { durationMs: Date.now() - started };
}

/**
 * How far a copy's length may drift from the source's: 2%, but never under a
 * quarter second, which AAC priming and frame-rate conversion can add on their own
 * (a 5 s test clip came out 5.067 s).
 */
export const lengthTolerance = (sourceDurationSec) => Math.max(0.25, sourceDurationSec * 0.02);

/**
 * Checks a finished copy before anything is uploaded: what `decideTranscode`
 * would skip, and close to the source's length. `problems` empty means good.
 */
export async function verifyWebCopy(filePath, { sourceDurationSec } = {}) {
  const { probe, boxes } = await inspectVideo(filePath);
  const decision = decideTranscode({ probe, boxes });
  const problems = [];
  if (decision.action !== DECISION.SKIP) problems.push(`not web-ready: ${decision.reason}`);
  if (decision.info.brand === 'qt') problems.push('still a QuickTime file');
  const duration = decision.info.durationSec;
  if (sourceDurationSec && duration && Math.abs(duration - sourceDurationSec) > lengthTolerance(sourceDurationSec)) {
    problems.push(`length ${duration.toFixed(1)}s differs from the source's ${sourceDurationSec.toFixed(1)}s`);
  }
  return { problems, info: decision.info, boxes };
}

// --- Mapping file -------------------------------------------------------------

export const MAPPING_STATUS = Object.freeze({
  // Written before the database write, so a run killed between the write and
  // its `repointed` row still leaves a record to revert from.
  REPOINTING: 'repointing',
  REPOINTED: 'repointed',
  REVERTED: 'reverted',
  SKIPPED: 'skipped',
  FAILED: 'failed',
  PLANNED: 'planned',
});

const MAPPING_FIELDS = ['applicationId', 'originalFileId', 'originalUrl', 'newFileId', 'newUrl',
  'originalBytes', 'newBytes', 'durationMs', 'status'];

/**
 * An append-only JSONL writer. Each row is written and flushed on its own, so a
 * run killed halfway still leaves a file that records every repoint it made.
 */
export function createMappingWriter(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  return {
    path: filePath,
    append(row) {
      const record = { at: new Date().toISOString() };
      for (const field of MAPPING_FIELDS) record[field] = row[field] ?? null;
      if (row.reason) record.reason = row.reason;
      if (row.action) record.action = row.action;
      fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`);
      return record;
    },
  };
}

/** Every row of a mapping file. Throws naming the line of anything unreadable. */
export function readMappingRows(filePath) {
  const rows = [];
  fs.readFileSync(filePath, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      rows.push(JSON.parse(line));
    } catch {
      throw new Error(`${filePath} line ${i + 1} is not JSON`);
    }
  });
  return rows;
}

/**
 * What a revert has to do: for each application a run repointed, put
 * `originalUrl` back, but only while videoUrl still reads `newUrl` (checked by
 * the caller at write time). An application repointed twice in one file is
 * reverted to its first original. A `repointing` row counts as well as a
 * `repointed` one: it is all a run killed mid-write leaves, and where the write
 * never happened the caller finds videoUrl already on the original and skips it.
 * Other rows are ignored.
 */
export function planRevert(rows) {
  const byApplication = new Map();
  for (const row of rows) {
    if (row.status !== MAPPING_STATUS.REPOINTED && row.status !== MAPPING_STATUS.REPOINTING) continue;
    if (!row.applicationId || !row.originalUrl || !row.newUrl) continue;
    const seen = byApplication.get(row.applicationId);
    byApplication.set(row.applicationId, seen
      ? { ...seen, newUrl: row.newUrl, newFileId: row.newFileId }
      : {
        applicationId: row.applicationId,
        originalUrl: row.originalUrl,
        originalFileId: row.originalFileId,
        newUrl: row.newUrl,
        newFileId: row.newFileId,
      });
  }
  return [...byApplication.values()];
}

// --- Reporting ----------------------------------------------------------------

export function formatBytes(bytes) {
  if (bytes == null || !Number.isFinite(Number(bytes))) return '?';
  const n = Number(bytes);
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
