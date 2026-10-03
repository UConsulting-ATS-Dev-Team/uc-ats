// The decision, the ffmpeg command and the mapping file, as data. Nothing here
// runs ffmpeg: the probes in videoTranscode.fixtures.json are real ffprobe output
// for clips made with `ffmpeg -f lavfi -i testsrc`, trimmed to the fields read.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DECISION,
  MAPPING_STATUS,
  buildFfmpegArgs,
  createMappingWriter,
  decideTranscode,
  isFaststart,
  isWebCopyName,
  lengthTolerance,
  parseFileUrl,
  planRevert,
  readMappingRows,
  readTopLevelBoxes,
  replaceFileId,
  summarizeProbe,
  targetSize,
  webCopyName,
} from './videoTranscode.js';

const fixtures = JSON.parse(fs.readFileSync(new URL('./videoTranscode.fixtures.json', import.meta.url), 'utf8'));

// Box orders as readTopLevelBoxes reported them for the same clips.
const INDEX_LAST_MOV = ['ftyp', 'wide', 'mdat', 'moov'];
const INDEX_LAST_MP4 = ['ftyp', 'free', 'mdat', 'moov'];
const FASTSTART_MP4 = ['ftyp', 'moov', 'free', 'mdat'];

describe('decideTranscode', () => {
  it('transcodes an iPhone-style .mov: HEVC, portrait 1080x1920, 60 fps, index last', () => {
    const d = decideTranscode({ probe: fixtures.iphoneMov, boxes: INDEX_LAST_MOV });
    expect(d.action).toBe(DECISION.TRANSCODE);
    expect(d.reason).toBe('video is hevc, 1080x1920 is over 720p, 60 fps');
    expect(d.target).toEqual({ width: 720, height: 1280 });
  });

  it('remuxes an H.264 720p MP4 whose index is at the end, without re-encoding', () => {
    const d = decideTranscode({ probe: fixtures.nonFaststartMp4, boxes: INDEX_LAST_MP4 });
    expect(d.action).toBe(DECISION.REMUX);
    expect(d.reason).toMatch(/index at the end/);
  });

  it('skips a faststart H.264/AAC MP4 at 720p', () => {
    const d = decideTranscode({ probe: fixtures.goodMp4, boxes: FASTSTART_MP4 });
    expect(d.action).toBe(DECISION.SKIP);
    expect(d.reason).toBe('already a faststart H.264 MP4 at or under 720p');
  });

  it('transcodes a 4K H.264 MP4 down to 1280x720 even though it is faststart', () => {
    const d = decideTranscode({ probe: fixtures.uhdMp4, boxes: FASTSTART_MP4 });
    expect(d.action).toBe(DECISION.TRANSCODE);
    expect(d.reason).toBe('3840x2160 is over 720p');
    expect(d.target).toEqual({ width: 1280, height: 720 });
  });

  it('reads a 90 degree rotation, so a sideways-stored phone video is sized as portrait', () => {
    const d = decideTranscode({ probe: fixtures.rotatedMov, boxes: INDEX_LAST_MOV });
    expect(d.info.video).toMatchObject({ width: 1080, height: 1920 });
    expect(d.target).toEqual({ width: 720, height: 1280 });
  });

  it('flags HLG HDR as needing a transcode', () => {
    const d = decideTranscode({ probe: fixtures.hdrMov, boxes: INDEX_LAST_MOV });
    expect(d.action).toBe(DECISION.TRANSCODE);
    expect(d.reason).toMatch(/HDR/);
    expect(d.info.video.hdr).toBe(true);
  });

  it('remuxes web-ready streams in a QuickTime container even with the index first', () => {
    const probe = { ...fixtures.goodMp4, format: { ...fixtures.goodMp4.format, tags: { major_brand: 'qt  ' } } };
    expect(decideTranscode({ probe, boxes: FASTSTART_MP4 }).action).toBe(DECISION.REMUX);
  });

  it('transcodes when the audio is not AAC', () => {
    const probe = structuredClone(fixtures.goodMp4);
    probe.streams.find((s) => s.codec_type === 'audio').codec_name = 'pcm_s16le';
    const d = decideTranscode({ probe, boxes: FASTSTART_MP4 });
    expect(d.action).toBe(DECISION.TRANSCODE);
    expect(d.reason).toBe('audio is pcm_s16le');
  });

  it('skips a file with no video stream instead of guessing', () => {
    const probe = { streams: [{ codec_type: 'audio', codec_name: 'aac' }], format: {} };
    const d = decideTranscode({ probe, boxes: FASTSTART_MP4 });
    expect(d.action).toBe(DECISION.SKIP);
    expect(d.reason).toMatch(/no video stream/);
  });

  it('allows variable-frame-rate jitter just over 30 fps', () => {
    const probe = structuredClone(fixtures.goodMp4);
    probe.streams[0].avg_frame_rate = '3001/100';
    expect(decideTranscode({ probe, boxes: FASTSTART_MP4 }).action).toBe(DECISION.SKIP);
  });
});

describe('targetSize', () => {
  it('never scales up', () => {
    expect(targetSize({ width: 640, height: 360 })).toEqual({ width: 640, height: 360 });
  });
  it('keeps 720 on the short edge for wide and tall video', () => {
    expect(targetSize({ width: 1920, height: 1080 })).toEqual({ width: 1280, height: 720 });
    expect(targetSize({ width: 1080, height: 1920 })).toEqual({ width: 720, height: 1280 });
  });
  it('fits the long edge in 1280 when the shape is wider than 16:9', () => {
    expect(targetSize({ width: 2560, height: 1080 })).toEqual({ width: 1280, height: 540 });
  });
  it('rounds to even sides, which H.264 4:2:0 needs', () => {
    const { width, height } = targetSize({ width: 1170, height: 2532 });
    expect(width % 2).toBe(0);
    expect(height % 2).toBe(0);
    expect(Math.max(width, height)).toBeLessThanOrEqual(1280);
    expect(targetSize({ width: 641, height: 361 })).toEqual({ width: 642, height: 362 });
  });
});

describe('buildFfmpegArgs', () => {
  const pair = (args, name) => args[args.indexOf(name) + 1];

  it('transcodes to H.264/AAC faststart MP4 at the target size, CRF 23, at most 30 fps', () => {
    const decision = decideTranscode({ probe: fixtures.iphoneMov, boxes: INDEX_LAST_MOV });
    const args = buildFfmpegArgs({ input: 'in.mov', output: 'out.web.mp4', decision });
    expect(pair(args, '-i')).toBe('in.mov');
    expect(args.at(-1)).toBe('out.web.mp4');
    expect(pair(args, '-c:v')).toBe('libx264');
    expect(pair(args, '-crf')).toBe('23');
    expect(pair(args, '-fpsmax')).toBe('30');
    expect(pair(args, '-c:a')).toBe('aac');
    expect(pair(args, '-movflags')).toBe('+faststart');
    expect(pair(args, '-f')).toBe('mp4');
    expect(pair(args, '-vf')).toMatch(/^scale=720:1280:flags=lanczos,format=yuv420p,setparams=/);
    // Optional audio map, so a silent video does not fail.
    expect(args.join(' ')).toContain('-map 0:a:0?');
    // Location and other global metadata are not carried over.
    expect(pair(args, '-map_metadata')).toBe('-1');
  });

  it('tone maps HDR only when this ffmpeg can', () => {
    const decision = decideTranscode({ probe: fixtures.hdrMov, boxes: INDEX_LAST_MOV });
    const withZscale = buildFfmpegArgs({ input: 'a', output: 'b', decision, canTonemap: true });
    const without = buildFfmpegArgs({ input: 'a', output: 'b', decision, canTonemap: false });
    expect(pair(withZscale, '-vf')).toMatch(/^zscale=.*tonemap=hable.*scale=1280:720/);
    expect(pair(without, '-vf')).not.toMatch(/zscale|tonemap/);
  });

  it('remuxes by copying streams', () => {
    const decision = decideTranscode({ probe: fixtures.nonFaststartMp4, boxes: INDEX_LAST_MP4 });
    const args = buildFfmpegArgs({ input: 'in.mp4', output: 'out.mp4', decision });
    expect(pair(args, '-c')).toBe('copy');
    expect(args).not.toContain('libx264');
    expect(pair(args, '-movflags')).toBe('+faststart');
  });

  it('refuses a skip decision', () => {
    const decision = decideTranscode({ probe: fixtures.goodMp4, boxes: FASTSTART_MP4 });
    expect(() => buildFfmpegArgs({ input: 'a', output: 'b', decision })).toThrow(/Nothing to run/);
  });
});

describe('names and URLs', () => {
  it('names the copy after the original', () => {
    expect(webCopyName('IMG_1234.MOV')).toBe('IMG_1234.web.mp4');
    expect(webCopyName('Jane Doe - video.mp4')).toBe('Jane Doe - video.web.mp4');
    expect(webCopyName('no-extension')).toBe('no-extension.web.mp4');
    expect(isWebCopyName('IMG_1234.web.mp4')).toBe(true);
    expect(isWebCopyName('IMG_1234.mp4')).toBe(false);
  });

  it('parses relative and absolute /api/files URLs and swaps only the id', () => {
    expect(parseFileUrl('/api/files/abc_123-X/pdf')).toEqual({ prefix: '/api/files/', fileId: 'abc_123-X', suffix: '/pdf' });
    expect(replaceFileId('https://uconsultingats.com/api/files/old/pdf', 'new')).toBe('https://uconsultingats.com/api/files/new/pdf');
    expect(replaceFileId('/api/files/old/pdf', 'new')).toBe('/api/files/new/pdf');
  });

  it('does not parse links that are not ours', () => {
    expect(parseFileUrl('https://drive.google.com/file/d/abc/view')).toBeNull();
    expect(parseFileUrl(null)).toBeNull();
    expect(() => replaceFileId('https://example.com/x', 'y')).toThrow();
  });
});

describe('readTopLevelBoxes / isFaststart', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boxes-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const box = (type, payload = 0) => {
    const b = Buffer.alloc(8 + payload);
    b.writeUInt32BE(8 + payload, 0);
    b.write(type, 4, 'latin1');
    return b;
  };
  const largeBox = (type, payload) => {
    const b = Buffer.alloc(16 + payload);
    b.writeUInt32BE(1, 0);
    b.write(type, 4, 'latin1');
    b.writeBigUInt64BE(BigInt(16 + payload), 8);
    return b;
  };

  it('reads box order, including 64-bit sizes, and tells index-first from index-last', async () => {
    const last = path.join(dir, 'last.mov');
    fs.writeFileSync(last, Buffer.concat([box('ftyp', 12), largeBox('mdat', 100), box('moov', 20)]));
    const first = path.join(dir, 'first.mp4');
    fs.writeFileSync(first, Buffer.concat([box('ftyp', 12), box('moov', 20), box('mdat', 100)]));

    expect(await readTopLevelBoxes(last)).toEqual(['ftyp', 'mdat', 'moov']);
    expect(await readTopLevelBoxes(first)).toEqual(['ftyp', 'moov', 'mdat']);
    expect(isFaststart(['ftyp', 'mdat', 'moov'])).toBe(false);
    expect(isFaststart(['ftyp', 'moov', 'mdat'])).toBe(true);
    expect(isFaststart(['ftyp', 'mdat'])).toBe(false);
  });

  it('stops on a corrupt size instead of looping', async () => {
    const bad = path.join(dir, 'bad.mp4');
    const corrupt = box('ftyp', 4);
    corrupt.writeUInt32BE(3, 0);
    fs.writeFileSync(bad, Buffer.concat([corrupt, box('moov')]));
    expect(await readTopLevelBoxes(bad)).toEqual([]);
  });
});

describe('summarizeProbe', () => {
  it('prefers avg_frame_rate and ignores attached cover art', () => {
    const probe = {
      streams: [
        { codec_type: 'video', codec_name: 'mjpeg', width: 300, height: 300, disposition: { attached_pic: 1 } },
        { codec_type: 'video', codec_name: 'h264', width: 1280, height: 720, pix_fmt: 'yuv420p', avg_frame_rate: '30000/1001', r_frame_rate: '60/1' },
      ],
      format: { tags: { major_brand: 'isom' } },
    };
    const { video } = summarizeProbe(probe);
    expect(video.codec).toBe('h264');
    expect(video.fps).toBeCloseTo(29.97, 2);
  });
});

describe('mapping file', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mapping-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('appends one JSON line per row with every field, null when unknown', () => {
    const file = path.join(dir, 'nested', 'video-transcode-x.jsonl');
    const writer = createMappingWriter(file);
    writer.append({ applicationId: 'a1', originalFileId: 'f1', originalUrl: '/api/files/f1/pdf', newFileId: 'n1', newUrl: '/api/files/n1/pdf', originalBytes: 100, newBytes: 30, durationMs: 5, status: 'repointed', action: 'transcode' });
    writer.append({ applicationId: 'a2', status: 'skipped', reason: 'already points at a web copy' });

    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    const [one, two] = lines.map((l) => JSON.parse(l));
    expect(Object.keys(one)).toEqual(expect.arrayContaining(['applicationId', 'originalFileId', 'originalUrl', 'newFileId', 'newUrl', 'originalBytes', 'newBytes', 'durationMs', 'status', 'at']));
    expect(one).toMatchObject({ newBytes: 30, action: 'transcode' });
    expect(two).toMatchObject({ applicationId: 'a2', newFileId: null, newUrl: null, status: 'skipped', reason: 'already points at a web copy' });
  });

  it('reads rows back and names the line of anything unreadable', () => {
    const file = path.join(dir, 'm.jsonl');
    fs.writeFileSync(file, '{"applicationId":"a"}\n\n{"applicationId":"b"}\n');
    expect(readMappingRows(file).map((r) => r.applicationId)).toEqual(['a', 'b']);
    fs.appendFileSync(file, '{oops\n');
    expect(() => readMappingRows(file)).toThrow(/line 4/);
  });

  it('plans a revert from repointed rows only, back to the first original', () => {
    const rows = [
      { applicationId: 'a1', status: MAPPING_STATUS.REPOINTED, originalFileId: 'o1', originalUrl: '/api/files/o1/pdf', newFileId: 'n1', newUrl: '/api/files/n1/pdf' },
      { applicationId: 'a2', status: MAPPING_STATUS.SKIPPED, originalUrl: '/api/files/o2/pdf' },
      { applicationId: 'a3', status: MAPPING_STATUS.FAILED, originalUrl: '/api/files/o3/pdf', newUrl: '/api/files/n3/pdf' },
      { applicationId: 'a4', status: MAPPING_STATUS.PLANNED, originalUrl: '/api/files/o4/pdf' },
      { applicationId: 'a1', status: MAPPING_STATUS.REPOINTED, originalFileId: 'n1', originalUrl: '/api/files/n1/pdf', newFileId: 'n1b', newUrl: '/api/files/n1b/pdf' },
    ];
    expect(planRevert(rows)).toEqual([
      { applicationId: 'a1', originalFileId: 'o1', originalUrl: '/api/files/o1/pdf', newFileId: 'n1b', newUrl: '/api/files/n1b/pdf' },
    ]);
  });

  it('round-trips: what the writer records, the revert plan reads', () => {
    const file = path.join(dir, 'rt.jsonl');
    const writer = createMappingWriter(file);
    writer.append({ applicationId: 'a1', originalFileId: 'o1', originalUrl: '/api/files/o1/pdf', newFileId: 'n1', newUrl: '/api/files/n1/pdf', status: MAPPING_STATUS.REPOINTED });
    expect(planRevert(readMappingRows(file))).toEqual([
      { applicationId: 'a1', originalFileId: 'o1', originalUrl: '/api/files/o1/pdf', newFileId: 'n1', newUrl: '/api/files/n1/pdf' },
    ]);
  });
});

describe('lengthTolerance', () => {
  it('is 2% of the source, with a quarter-second floor for short clips', () => {
    expect(lengthTolerance(5)).toBe(0.25);
    expect(lengthTolerance(60)).toBeCloseTo(1.2);
    expect(lengthTolerance(120)).toBeCloseTo(2.4);
  });
});
