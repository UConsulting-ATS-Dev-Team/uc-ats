// The storage layer's production guard.
//
// The rule worth pinning down is the one that cost a production debugging
// session: without Supabase credentials the layer used to write to the
// instance's local disk, which on Render is wiped by the next deploy. The
// upload was accepted, the row was written, and the file was gone — with
// nothing anywhere to say so.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../supabaseClient.js', () => ({
  default: null,
  isSupabaseAvailable: () => false,
}));

const original = process.env.NODE_ENV;

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  process.env.NODE_ENV = original;
});

describe('when Supabase is not configured', () => {
  it('refuses the upload in production rather than writing somewhere temporary', async () => {
    process.env.NODE_ENV = 'production';
    const { putResume } = await import('./resumeStorage.js');

    await expect(putResume('member-resumes/x/resume.pdf', Buffer.from('%PDF-'))).rejects.toThrow(
      /not configured/i
    );
  });

  it('tags the failure so a route can report it as a misconfiguration', async () => {
    process.env.NODE_ENV = 'production';
    const { putResume, storageErrorResponse } = await import('./resumeStorage.js');

    const error = await putResume('member-resumes/x/resume.pdf', Buffer.from('%PDF-')).catch((e) => e);
    expect(error.code).toBe('STORAGE_NOT_CONFIGURED');

    // 503, not 500: the request was fine, the service is not, and it will work
    // once someone sets the variables.
    expect(storageErrorResponse(error)).toMatchObject({ status: 503 });
  });

  it('still falls back to disk outside production, which is why the path exists', async () => {
    process.env.NODE_ENV = 'development';
    const { putResume, getResume, removeResume } = await import('./resumeStorage.js');

    const key = 'member-resumes/__unit__/resume.pdf';
    const body = Buffer.from('%PDF-1.4 local');
    await putResume(key, body);
    expect(await getResume(key)).toEqual(body);
    await removeResume(key);
  });
});

describe('storageErrorResponse', () => {
  it('ignores ordinary failures, which must keep their own handling', async () => {
    const { storageErrorResponse } = await import('./resumeStorage.js');
    expect(storageErrorResponse(new Error('network blew up'))).toBeNull();
    expect(storageErrorResponse(undefined)).toBeNull();
  });
});
