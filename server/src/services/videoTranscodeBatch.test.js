// The per-file steps and the pool, against a stubbed Drive and a stubbed repoint.
// ffprobe/ffmpeg are stubbed too, so this runs where neither is installed; the
// real ffmpeg path is exercised by hand (see the PR) rather than in CI.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const fixtures = JSON.parse(fs.readFileSync(new URL('./videoTranscode.fixtures.json', import.meta.url), 'utf8'));

const { inspectVideo, transcodeVideo, verifyWebCopy } = vi.hoisted(() => ({
  inspectVideo: vi.fn(),
  transcodeVideo: vi.fn(),
  verifyWebCopy: vi.fn(),
}));

vi.mock('./videoTranscode.js', async (importOriginal) => ({
  ...(await importOriginal()),
  inspectVideo,
  transcodeVideo,
  verifyWebCopy,
}));

const { DriveStepError, groupByVideoFile, processVideoFile, runPool } = await import('./videoTranscodeBatch.js');

// What the stubbed download writes, and so what a copy of it is tagged with.
const SOURCE_MD5 = crypto.createHash('md5').update('source').digest('hex');
const MOV = { id: 'orig1', name: 'IMG_0001.MOV', mimeType: 'video/quicktime', size: '48000000', md5Checksum: SOURCE_MD5, parents: ['folderA'] };
const app = (id, fileId = 'orig1', origin = '') => ({ id, videoUrl: `${origin}/api/files/${fileId}/pdf` });

function stubDrive(overrides = {}) {
  return {
    getFileMetadata: vi.fn(async () => MOV),
    listFilesByAppProperty: vi.fn(async () => []),
    downloadFile: vi.fn(async (_id, dest) => { fs.writeFileSync(dest, 'source'); return 6; }),
    uploadFile: vi.fn(async () => ({ id: 'web1', name: 'IMG_0001.web.mp4' })),
    ...overrides,
  };
}

let scratchDir;
beforeEach(() => {
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcode-batch-'));
  inspectVideo.mockReset().mockResolvedValue({ probe: fixtures.iphoneMov, boxes: ['ftyp', 'wide', 'mdat', 'moov'] });
  transcodeVideo.mockReset().mockImplementation(async ({ output }) => {
    fs.writeFileSync(output, Buffer.alloc(16_000_000));
    return { durationMs: 1234 };
  });
  verifyWebCopy.mockReset().mockResolvedValue({ problems: [], info: {}, boxes: ['ftyp', 'moov', 'mdat'] });
});
afterEach(() => fs.rmSync(scratchDir, { recursive: true, force: true }));

describe('groupByVideoFile', () => {
  it('groups shared files and reports links that are not ours', () => {
    const { groups, unparsed } = groupByVideoFile([
      app('a1', 'f1'), app('a2', 'f1', 'https://uconsultingats.com'), app('a3', 'f2'),
      { id: 'a4', videoUrl: 'https://drive.google.com/file/d/x/view' },
    ]);
    expect(groups.map((g) => [g.fileId, g.applications.map((a) => a.id)])).toEqual([['f1', ['a1', 'a2']], ['f2', ['a3']]]);
    expect(unparsed).toEqual([{ application: expect.objectContaining({ id: 'a4' }), reason: expect.stringMatching(/not an \/api\/files/) }]);
  });
});

describe('processVideoFile --apply', () => {
  it('downloads, transcodes, uploads next to the original as video/mp4, and repoints every application', async () => {
    const drive = stubDrive();
    const repoint = vi.fn(async () => {});
    const applications = [app('a1'), app('a2', 'orig1', 'https://uconsultingats.com')];

    const result = await processVideoFile({ fileId: 'orig1', applications, apply: true, scratchDir, drive, repoint });

    expect(result.status).toBe('repointed');
    expect(result).toMatchObject({ originalBytes: 48_000_000, newBytes: 16_000_000, durationMs: 1234, action: 'transcode', newFileId: 'web1' });
    const upload = drive.uploadFile.mock.calls[0][0];
    expect(upload).toMatchObject({ name: 'IMG_0001.web.mp4', folderId: 'folderA', mimeType: 'video/mp4', appProperties: { transcodedFrom: 'orig1' } });
    expect(repoint.mock.calls.map((c) => c[0])).toEqual([
      { applicationId: 'a1', fromUrl: '/api/files/orig1/pdf', toUrl: '/api/files/web1/pdf' },
      { applicationId: 'a2', fromUrl: 'https://uconsultingats.com/api/files/orig1/pdf', toUrl: 'https://uconsultingats.com/api/files/web1/pdf' },
    ]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      applicationId: 'a1', originalFileId: 'orig1', originalUrl: '/api/files/orig1/pdf', newFileId: 'web1', newUrl: '/api/files/web1/pdf', status: 'repointed',
    });
    // Scratch files are removed.
    expect(fs.readdirSync(scratchDir)).toEqual([]);
  });

  it('skips a source that is already web-ready, without uploading', async () => {
    inspectVideo.mockResolvedValue({ probe: fixtures.goodMp4, boxes: ['ftyp', 'moov', 'free', 'mdat'] });
    const drive = stubDrive({ getFileMetadata: vi.fn(async () => ({ ...MOV, name: 'v.mp4', mimeType: 'video/mp4' })) });
    const repoint = vi.fn();
    const result = await processVideoFile({ fileId: 'orig1', applications: [app('a1')], apply: true, scratchDir, drive, repoint });
    expect(result.status).toBe('skipped');
    expect(result.reason).toMatch(/already a faststart H.264 MP4/);
    expect(transcodeVideo).not.toHaveBeenCalled();
    expect(drive.uploadFile).not.toHaveBeenCalled();
    expect(repoint).not.toHaveBeenCalled();
  });

  it('does not read a web-ready download again to hash it, on --apply or --probe', async () => {
    inspectVideo.mockResolvedValue({ probe: fixtures.goodMp4, boxes: ['ftyp', 'moov', 'free', 'mdat'] });
    const reads = vi.spyOn(fs, 'createReadStream');
    try {
      for (const mode of [{ apply: true }, { probe: true }]) {
        const drive = stubDrive({ getFileMetadata: vi.fn(async () => ({ ...MOV, name: 'v.mp4', mimeType: 'video/mp4' })) });
        const result = await processVideoFile({ fileId: 'orig1', applications: [app('a1')], ...mode, scratchDir, drive, repoint: vi.fn() });
        expect(result.status).toBe('skipped');
        expect(drive.downloadFile).toHaveBeenCalledTimes(1);
      }
      expect(reads).not.toHaveBeenCalled();
      // The same spy does see the hash of a file that needs a copy.
      inspectVideo.mockResolvedValue({ probe: fixtures.iphoneMov, boxes: ['ftyp', 'wide', 'mdat', 'moov'] });
      await processVideoFile({ fileId: 'orig1', applications: [app('a1')], probe: true, scratchDir, drive: stubDrive(), repoint: vi.fn() });
      expect(reads).toHaveBeenCalledWith(expect.stringMatching(/\.source$/));
    } finally {
      reads.mockRestore();
    }
  });

  it('skips a videoUrl that already points at a web copy, before downloading anything', async () => {
    const drive = stubDrive({ getFileMetadata: vi.fn(async () => ({ ...MOV, name: 'IMG_0001.web.mp4', mimeType: 'video/mp4' })) });
    const result = await processVideoFile({ fileId: 'orig1', applications: [app('a1')], apply: true, scratchDir, drive, repoint: vi.fn() });
    expect(result).toMatchObject({ status: 'skipped', reason: 'already points at a web copy', driveConfirmed: true });
    expect(drive.downloadFile).not.toHaveBeenCalled();
  });

  it('reuses a copy an interrupted run uploaded, after checking it, instead of transcoding again', async () => {
    const drive = stubDrive({ listFilesByAppProperty: vi.fn(async () => [{ id: 'webOld', mimeType: 'video/mp4', size: '15000000', appProperties: { transcodedFrom: 'orig1', transcodedFromMd5: SOURCE_MD5 } }]) });
    const repoint = vi.fn(async () => {});
    const result = await processVideoFile({ fileId: 'orig1', applications: [app('a1')], apply: true, scratchDir, drive, repoint });
    expect(drive.listFilesByAppProperty).toHaveBeenCalledWith({ folderId: 'folderA', key: 'transcodedFrom', value: 'orig1', fields: 'id, name, mimeType, size, appProperties' });
    expect(drive.downloadFile.mock.calls.map((c) => c[0])).toEqual(['orig1', 'webOld']);
    // Checked against the source's length like a fresh copy.
    expect(verifyWebCopy).toHaveBeenCalledWith(expect.stringMatching(/\.web\.mp4$/), { sourceDurationSec: 5 });
    expect(transcodeVideo).not.toHaveBeenCalled();
    expect(drive.uploadFile).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'repointed', newFileId: 'webOld', action: 'reuse', driveConfirmed: true });
    expect(repoint).toHaveBeenCalledWith({ applicationId: 'a1', fromUrl: '/api/files/orig1/pdf', toUrl: '/api/files/webOld/pdf' });
  });

  it('makes a fresh copy when the tagged one is not an MP4 or fails its check', async () => {
    const drive = stubDrive({
      listFilesByAppProperty: vi.fn(async () => [
        { id: 'notVideo', mimeType: 'application/pdf' },
        { id: 'broken', mimeType: 'video/mp4', appProperties: { transcodedFromMd5: SOURCE_MD5 } },
      ]),
    });
    verifyWebCopy
      .mockResolvedValueOnce({ problems: ['not web-ready: index at the end'], info: {}, boxes: [] })
      .mockResolvedValue({ problems: [], info: {}, boxes: [] });
    const repoint = vi.fn(async () => {});
    const result = await processVideoFile({ fileId: 'orig1', applications: [app('a1')], apply: true, scratchDir, drive, repoint });
    expect(drive.downloadFile.mock.calls.map((c) => c[0])).toEqual(['orig1', 'broken']);
    expect(transcodeVideo).toHaveBeenCalledTimes(1);
    expect(drive.uploadFile).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'repointed', newFileId: 'web1', action: 'transcode' });
    expect(result.reason).toMatch(/did not reuse notVideo \(type is application\/pdf\), broken \(not web-ready/);
  });

  it('does not reuse a copy made from another version of the original, or one it cannot place', async () => {
    const drive = stubDrive({
      listFilesByAppProperty: vi.fn(async () => [
        { id: 'stale', mimeType: 'video/mp4', appProperties: { transcodedFrom: 'orig1', transcodedFromMd5: 'md5Before' } },
        { id: 'untagged', mimeType: 'video/mp4', appProperties: { transcodedFrom: 'orig1' } },
      ]),
    });
    const repoint = vi.fn(async () => {});
    const result = await processVideoFile({ fileId: 'orig1', applications: [app('a1')], apply: true, scratchDir, drive, repoint });
    // Neither is even downloaded: the tag settles it.
    expect(drive.downloadFile.mock.calls.map((c) => c[0])).toEqual(['orig1']);
    expect(transcodeVideo).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ status: 'repointed', newFileId: 'web1', action: 'transcode' });
    expect(result.reason).toMatch(/did not reuse stale \(made from another version of the original\), untagged \(cannot tell which version/);
  });

  it('goes by the bytes it downloaded, so an original replaced after its metadata was read is not matched to the old copy', async () => {
    // Drive said md5Before when asked; by the download the file was different.
    const drive = stubDrive({
      getFileMetadata: vi.fn(async () => ({ ...MOV, md5Checksum: 'md5Before' })),
      listFilesByAppProperty: vi.fn(async () => [
        { id: 'ofTheOldVideo', mimeType: 'video/mp4', appProperties: { transcodedFrom: 'orig1', transcodedFromMd5: 'md5Before' } },
      ]),
    });
    const result = await processVideoFile({ fileId: 'orig1', applications: [app('a1')], apply: true, scratchDir, drive, repoint: vi.fn(async () => {}) });
    expect(drive.downloadFile.mock.calls.map((c) => c[0])).toEqual(['orig1']);
    expect(result).toMatchObject({ status: 'repointed', newFileId: 'web1', action: 'transcode' });
    expect(drive.uploadFile.mock.calls[0][0].appProperties.transcodedFromMd5).toBe(SOURCE_MD5);
  });

  it('tags a new copy with the original id and its checksum', async () => {
    const drive = stubDrive();
    await processVideoFile({ fileId: 'orig1', applications: [app('a1')], apply: true, scratchDir, drive, repoint: vi.fn(async () => {}) });
    expect(drive.uploadFile.mock.calls[0][0].appProperties).toEqual({ transcodedFrom: 'orig1', transcodedFromMd5: SOURCE_MD5 });
  });

  it('records a repointing row before each database write', async () => {
    const order = [];
    const record = vi.fn(async (row) => { order.push(`record ${row.applicationId} ${row.status}`); });
    const repoint = vi.fn(async ({ applicationId }) => { order.push(`repoint ${applicationId}`); });
    await processVideoFile({ fileId: 'orig1', applications: [app('a1'), app('a2')], apply: true, scratchDir, drive: stubDrive(), repoint, record });
    expect(order).toEqual(['record a1 repointing', 'repoint a1', 'record a2 repointing', 'repoint a2']);
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      applicationId: 'a1', originalFileId: 'orig1', originalUrl: '/api/files/orig1/pdf', newFileId: 'web1', newUrl: '/api/files/web1/pdf',
    }));
  });

  it('does not repoint an application whose rollback record could not be written', async () => {
    const record = vi.fn(async (row) => { if (row.applicationId === 'a1') throw new Error('ENOSPC'); });
    const repoint = vi.fn(async () => {});
    const result = await processVideoFile({ fileId: 'orig1', applications: [app('a1'), app('a2')], apply: true, scratchDir, drive: stubDrive(), repoint, record });
    expect(repoint).toHaveBeenCalledTimes(1);
    expect(repoint).toHaveBeenCalledWith(expect.objectContaining({ applicationId: 'a2' }));
    expect(result.status).toBe('failed');
    expect(result.rows.map((r) => [r.applicationId, r.status])).toEqual([['a1', 'failed'], ['a2', 'repointed']]);
    expect(result.rows[0].reason).toMatch(/could not write the rollback record \(ENOSPC\)/);
  });

  it('does not upload a copy that fails its check', async () => {
    verifyWebCopy.mockResolvedValue({ problems: ['not web-ready: index at the end'], info: {}, boxes: [] });
    const drive = stubDrive();
    const result = await processVideoFile({ fileId: 'orig1', applications: [app('a1')], apply: true, scratchDir, drive, repoint: vi.fn() });
    expect(result.status).toBe('failed');
    expect(result.reason).toMatch(/failed its check/);
    expect(drive.uploadFile).not.toHaveBeenCalled();
  });

  it('reports an ffmpeg failure as a failed row, not a Drive failure', async () => {
    transcodeVideo.mockRejectedValue(new Error('ffmpeg exited 1: moov atom not found'));
    const result = await processVideoFile({ fileId: 'orig1', applications: [app('a1')], apply: true, scratchDir, drive: stubDrive(), repoint: vi.fn() });
    expect(result).toMatchObject({ status: 'failed', reason: expect.stringMatching(/ffmpeg failed/), driveConfirmed: false });
    expect(fs.readdirSync(scratchDir)).toEqual([]);
  });

  it('records a repoint that lost a race as failed for that application only', async () => {
    const repoint = vi.fn()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new Error('videoUrl changed since this run read it; left as is'));
    const result = await processVideoFile({ fileId: 'orig1', applications: [app('a1'), app('a2')], apply: true, scratchDir, drive: stubDrive(), repoint });
    expect(result.status).toBe('failed');
    expect(result.rows.map((r) => r.status)).toEqual(['repointed', 'failed']);
    expect(result.rows[1]).toMatchObject({ newFileId: 'web1', reason: expect.stringMatching(/changed since/) });
  });

  it('throws Drive failures as DriveStepError so the pool can count them', async () => {
    const drive = stubDrive({ downloadFile: vi.fn(async () => { throw new Error('rateLimitExceeded'); }) });
    await expect(processVideoFile({ fileId: 'orig1', applications: [app('a1')], apply: true, scratchDir, drive, repoint: vi.fn() }))
      .rejects.toBeInstanceOf(DriveStepError);
  });

  it('skips anything that is not a video, or is trashed, with its reason', async () => {
    const pdf = stubDrive({ getFileMetadata: vi.fn(async () => ({ ...MOV, mimeType: 'application/pdf' })) });
    expect((await processVideoFile({ fileId: 'orig1', applications: [app('a1')], apply: true, scratchDir, drive: pdf, repoint: vi.fn() })).reason)
      .toBe('not a video (application/pdf)');
    const trashed = stubDrive({ getFileMetadata: vi.fn(async () => ({ ...MOV, trashed: true })) });
    expect((await processVideoFile({ fileId: 'orig1', applications: [app('a1')], apply: true, scratchDir, drive: trashed, repoint: vi.fn() })).reason)
      .toMatch(/trash/);
  });
});

describe('processVideoFile dry run', () => {
  it('reads metadata only by default and never uploads or repoints', async () => {
    const drive = stubDrive();
    const repoint = vi.fn();
    const result = await processVideoFile({ fileId: 'orig1', applications: [app('a1')], scratchDir, drive, repoint });
    expect(result).toMatchObject({ status: 'planned', reason: 'QuickTime; would transcode or remux' });
    expect(drive.downloadFile).not.toHaveBeenCalled();
    expect(drive.uploadFile).not.toHaveBeenCalled();
    expect(repoint).not.toHaveBeenCalled();
  });

  it('with --probe downloads and reports the real decision, still without writing', async () => {
    const drive = stubDrive();
    const repoint = vi.fn();
    const result = await processVideoFile({ fileId: 'orig1', applications: [app('a1')], probe: true, scratchDir, drive, repoint });
    expect(result).toMatchObject({ status: 'planned', action: 'transcode' });
    expect(result.reason).toMatch(/^would transcode: video is hevc/);
    expect(transcodeVideo).not.toHaveBeenCalled();
    expect(drive.uploadFile).not.toHaveBeenCalled();
    expect(repoint).not.toHaveBeenCalled();
  });
  it('says in a dry run whether a leftover copy would be reused, by its tag', async () => {
    const run = (copies, probe) => processVideoFile({
      fileId: 'orig1', applications: [app('a1')], probe, scratchDir, repoint: vi.fn(),
      drive: stubDrive({ listFilesByAppProperty: vi.fn(async () => copies) }),
    });
    const current = { id: 'webOld', mimeType: 'video/mp4', appProperties: { transcodedFromMd5: SOURCE_MD5 } };
    const stale = { id: 'stale', mimeType: 'video/mp4', appProperties: { transcodedFromMd5: 'md5Before' } };
    for (const probe of [false, true]) {
      expect((await run([stale, current], probe)).reason).toMatch(/leftover web copy webOld matches this original, would reuse it if it passes its check/);
      expect((await run([stale], probe)).reason).toMatch(/leftover web copy stale \(made from another version of the original\) would not be reused/);
      expect((await run([], probe)).reason).not.toMatch(/leftover/);
    }
  });
});

describe('runPool', () => {
  const groups = (n) => Array.from({ length: n }, (_, i) => ({ fileId: `f${i}`, applications: [] }));

  it('runs at most `concurrency` at once and reports every result', async () => {
    let running = 0;
    let peak = 0;
    const seen = [];
    const outcome = await runPool({
      groups: groups(7),
      concurrency: 3,
      processOne: async (g) => {
        running += 1; peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 5));
        running -= 1;
        return { status: 'repointed', fileId: g.fileId };
      },
      onResult: (g, result) => seen.push(result.fileId),
    });
    expect(peak).toBe(3);
    expect(seen.sort()).toEqual(groups(7).map((g) => g.fileId).sort());
    expect(outcome).toEqual({ processed: 7, notStarted: 0, stopReason: null });
  });

  it('counts --limit in files that needed work, so finished ones are passed over', async () => {
    // Two files an earlier run finished, then five that still need a copy.
    const started = [];
    const outcome = await runPool({
      groups: groups(7),
      concurrency: 2,
      limit: 3,
      processOne: async (g) => {
        started.push(g.fileId);
        await new Promise((r) => setTimeout(r, 2));
        return ['f0', 'f1'].includes(g.fileId) ? { status: 'skipped', driveConfirmed: true } : { status: 'repointed', driveConfirmed: true };
      },
      onResult: () => {},
    });
    expect(started).toEqual(['f0', 'f1', 'f2', 'f3', 'f4']);
    expect(outcome).toEqual({ processed: 5, notStarted: 2, stopReason: null });
  });

  it('never works on more than --limit files at once, and counts a failure as one', async () => {
    let running = 0;
    let peak = 0;
    const outcome = await runPool({
      groups: groups(6),
      concurrency: 3,
      limit: 2,
      processOne: async (g) => {
        running += 1; peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 2));
        running -= 1;
        if (g.fileId === 'f0') throw new Error('ffmpeg');
        return { status: 'repointed', driveConfirmed: true };
      },
      onResult: () => {},
    });
    expect(peak).toBe(2);
    expect(outcome).toEqual({ processed: 2, notStarted: 4, stopReason: null });
  });

  it('finishes when every file is a skip and the limit is never reached', async () => {
    const outcome = await runPool({
      groups: groups(5), concurrency: 3, limit: 1,
      processOne: async () => ({ status: 'skipped', driveConfirmed: true }),
      onResult: () => {},
    });
    expect(outcome).toEqual({ processed: 5, notStarted: 0, stopReason: null });
  });

  it('stops after repeated Drive failures and leaves the rest unstarted', async () => {
    const errors = [];
    const outcome = await runPool({
      groups: groups(10),
      concurrency: 1,
      maxDriveFailures: 3,
      processOne: async () => { throw new DriveStepError('download', new Error('403 forbidden')); },
      onResult: (g, result, error) => errors.push(error),
    });
    expect(errors).toHaveLength(3);
    expect(outcome.processed).toBe(3);
    expect(outcome.notStarted).toBe(7);
    expect(outcome.stopReason).toMatch(/3 Drive failures in a row/);
  });

  it('resets the Drive count on a file that finished its Drive calls, not on an ffmpeg failure', async () => {
    const run = async (script) => {
      let i = 0;
      return runPool({
        groups: groups(script.length),
        concurrency: 1,
        maxDriveFailures: 3,
        processOne: async () => {
          const step = script[i++];
          if (step === 'drive') throw new DriveStepError('metadata', new Error('x'));
          if (step === 'other') throw new Error('ffmpeg');
          if (step === 'skip') return { status: 'skipped', driveConfirmed: true };
          if (step === 'badcopy') return { status: 'failed', driveConfirmed: false };
          return { status: 'repointed', driveConfirmed: true };
        },
        onResult: () => {},
      });
    };
    expect(await run(['drive', 'drive', 'ok', 'drive', 'drive', 'skip', 'drive', 'drive', 'ok']))
      .toEqual({ processed: 9, notStarted: 0, stopReason: null });
    const interleaved = await run(['drive', 'badcopy', 'drive', 'other', 'drive', 'ok', 'ok']);
    expect(interleaved.stopReason).toMatch(/3 Drive failures/);
    expect(interleaved.notStarted).toBe(2);
  });
});
