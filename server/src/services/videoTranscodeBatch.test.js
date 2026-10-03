// The per-file steps and the pool, against a stubbed Drive and a stubbed repoint.
// ffprobe/ffmpeg are stubbed too, so this runs where neither is installed; the
// real ffmpeg path is exercised by hand (see the PR) rather than in CI.
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

const MOV = { id: 'orig1', name: 'IMG_0001.MOV', mimeType: 'video/quicktime', size: '48000000', parents: ['folderA'] };
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

  it('skips a videoUrl that already points at a web copy, before downloading anything', async () => {
    const drive = stubDrive({ getFileMetadata: vi.fn(async () => ({ ...MOV, name: 'IMG_0001.web.mp4', mimeType: 'video/mp4' })) });
    const result = await processVideoFile({ fileId: 'orig1', applications: [app('a1')], apply: true, scratchDir, drive, repoint: vi.fn() });
    expect(result).toMatchObject({ status: 'skipped', reason: 'already points at a web copy' });
    expect(drive.downloadFile).not.toHaveBeenCalled();
  });

  it('reuses a copy an interrupted run uploaded, instead of transcoding again', async () => {
    const drive = stubDrive({ listFilesByAppProperty: vi.fn(async () => [{ id: 'webOld', size: '15000000' }]) });
    const repoint = vi.fn(async () => {});
    const result = await processVideoFile({ fileId: 'orig1', applications: [app('a1')], apply: true, scratchDir, drive, repoint });
    expect(drive.listFilesByAppProperty).toHaveBeenCalledWith({ folderId: 'folderA', key: 'transcodedFrom', value: 'orig1' });
    expect(drive.downloadFile).not.toHaveBeenCalled();
    expect(result).toMatchObject({ status: 'repointed', newFileId: 'webOld', action: 'reuse' });
    expect(repoint).toHaveBeenCalledWith({ applicationId: 'a1', fromUrl: '/api/files/orig1/pdf', toUrl: '/api/files/webOld/pdf' });
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
    expect(result).toMatchObject({ status: 'failed', reason: expect.stringMatching(/ffmpeg failed/) });
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

  it('does not count ffmpeg or other failures towards the Drive stop, and a success resets it', async () => {
    const script = ['drive', 'drive', 'ok', 'drive', 'drive', 'other', 'drive', 'drive', 'ok'];
    let i = 0;
    const outcome = await runPool({
      groups: groups(script.length),
      concurrency: 1,
      maxDriveFailures: 3,
      processOne: async () => {
        const step = script[i++];
        if (step === 'drive') throw new DriveStepError('metadata', new Error('x'));
        if (step === 'other') throw new Error('ffmpeg');
        return { status: 'repointed' };
      },
      onResult: () => {},
    });
    expect(outcome).toEqual({ processed: script.length, notStarted: 0, stopReason: null });
  });
});
