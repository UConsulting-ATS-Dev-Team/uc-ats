// Case book storage.
//
// Case page images used to live on the instance's own disk. On Render that disk
// is wiped by each deploy and differs per instance, so a page row could name an
// image no instance had, and the viewer showed "Page unavailable" for it.
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

describe('without Supabase', () => {
  it('refuses an upload in production rather than writing to a disk the next deploy wipes', async () => {
    process.env.NODE_ENV = 'production';
    const { putCaseFile } = await import('./caseStorage.js');
    const { storageErrorResponse } = await import('./resumeStorage.js');

    const error = await putCaseFile('cases/c/pages/x.webp', Buffer.from('img'), 'image/webp').catch((e) => e);
    expect(error.code).toBe('STORAGE_NOT_CONFIGURED');
    expect(storageErrorResponse(error)).toMatchObject({ status: 503 });
  });

  it('falls back to disk outside production, and reads and removes what it wrote', async () => {
    process.env.NODE_ENV = 'development';
    const { putCaseFile, getCaseFile, removeCaseFiles } = await import('./caseStorage.js');

    const key = 'cases/__unit__/pages/one.webp';
    const body = Buffer.from('webp bytes');
    await putCaseFile(key, body, 'image/webp');
    expect(await getCaseFile(key)).toEqual(body);

    await removeCaseFiles([key]);
    expect(await getCaseFile(key)).toBeNull();
  });

  it('will not read or write outside the cases tree, whatever the database says', async () => {
    process.env.NODE_ENV = 'development';
    const { putCaseFile, getCaseFile } = await import('./caseStorage.js');

    expect(await getCaseFile('cases/../resumes/someone.pdf')).toBeNull();
    expect(await getCaseFile('../../package.json')).toBeNull();
    await expect(putCaseFile('cases/../escape.webp', Buffer.from('x'), 'image/webp')).rejects.toThrow(/invalid/i);
  });
});

describe('casePageKey', () => {
  it('is new for every upload, so a renumbered page never shares a file with another', async () => {
    const { casePageKey } = await import('./caseStorage.js');
    const a = casePageKey('case-1', '.webp');
    const b = casePageKey('case-1', '.webp');

    expect(a).toMatch(/^cases\/case-1\/pages\/[0-9a-f-]{36}\.webp$/);
    expect(a).not.toBe(b);
  });
});
