import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import apiClient from './api';
import { getDocumentLink, clearDocumentLinks, REUSE_MARGIN_MS } from './documentLinks';

vi.mock('./api', () => ({ default: { post: vi.fn(), token: 'session-a' } }));

const NOW = Date.UTC(2026, 9, 3, 12, 0, 0);
// A link token as the server signs it: a JWT whose payload carries `exp` (seconds).
const linkToken = (name, expiresInMs = 15 * 60 * 1000) => {
  const payload = btoa(JSON.stringify({ resource: name, exp: Math.floor((NOW + expiresInMs) / 1000) }))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `eyJhbGciOiJIUzI1NiJ9.${payload}.sig-${name}`;
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  apiClient.token = 'session-a';
  apiClient.post.mockReset();
  clearDocumentLinks();
});
afterEach(() => vi.useRealTimers());

describe('getDocumentLink', () => {
  it('hands back the same link for a second open, so the URL (and the browser cache) is the same', async () => {
    apiClient.post.mockResolvedValueOnce({ access: linkToken('one') });
    const first = await getDocumentLink('/files/vid/link');
    const second = await getDocumentLink('/files/vid/link');
    expect(second).toBe(first);
    expect(apiClient.post).toHaveBeenCalledTimes(1);
  });

  it('keeps links for different documents apart', async () => {
    apiClient.post.mockResolvedValueOnce({ access: linkToken('a') }).mockResolvedValueOnce({ access: linkToken('b') });
    expect(await getDocumentLink('/files/a/link')).toBe(linkToken('a'));
    expect(await getDocumentLink('/files/b/link')).toBe(linkToken('b'));
  });

  it('signs a new one once the old has less than the margin left', async () => {
    apiClient.post.mockResolvedValueOnce({ access: linkToken('old') }).mockResolvedValueOnce({ access: linkToken('new', 30 * 60 * 1000) });
    await getDocumentLink('/files/vid/link');
    vi.setSystemTime(NOW + 15 * 60 * 1000 - REUSE_MARGIN_MS + 1);
    expect(await getDocumentLink('/files/vid/link')).toBe(linkToken('new', 30 * 60 * 1000));
    expect(apiClient.post).toHaveBeenCalledTimes(2);
  });

  it('signs anew when asked for a fresh link, and reuses that one after', async () => {
    apiClient.post.mockResolvedValueOnce({ access: linkToken('failed') }).mockResolvedValueOnce({ access: linkToken('renewed') });
    await getDocumentLink('/files/vid/link');
    expect(await getDocumentLink('/files/vid/link', { fresh: true })).toBe(linkToken('renewed'));
    expect(await getDocumentLink('/files/vid/link')).toBe(linkToken('renewed'));
  });

  it('never hands one sign-in a link issued to another', async () => {
    apiClient.post.mockResolvedValueOnce({ access: linkToken('a') }).mockResolvedValueOnce({ access: linkToken('b') });
    await getDocumentLink('/files/vid/link');
    apiClient.token = 'session-b';
    expect(await getDocumentLink('/files/vid/link')).toBe(linkToken('b'));
  });

  it('survives a reload through sessionStorage, without storing the sign-in token', async () => {
    apiClient.post.mockResolvedValueOnce({ access: linkToken('one') });
    await getDocumentLink('/files/vid/link');
    const stored = sessionStorage.getItem('documentLinks');
    expect(stored).toContain(linkToken('one'));
    expect(stored).not.toContain('session-a');

    vi.resetModules();
    const fresh = await import('./documentLinks');
    expect(await fresh.getDocumentLink('/files/vid/link')).toBe(linkToken('one'));
    expect(apiClient.post).toHaveBeenCalledTimes(1);
  });

  it('shares one request between opens that ask at the same moment', async () => {
    apiClient.post.mockResolvedValueOnce({ access: linkToken('one') });
    const [a, b] = await Promise.all([getDocumentLink('/files/vid/link'), getDocumentLink('/files/vid/link')]);
    expect(a).toBe(b);
    expect(apiClient.post).toHaveBeenCalledTimes(1);
  });

  it('does not keep a link whose expiry it cannot read, or a failed request', async () => {
    apiClient.post.mockResolvedValueOnce({ access: 'opaque' }).mockRejectedValueOnce(new Error('403'))
      .mockResolvedValueOnce({ access: linkToken('ok') });
    await getDocumentLink('/files/vid/link');
    await expect(getDocumentLink('/files/vid/link')).rejects.toThrow('403');
    expect(await getDocumentLink('/files/vid/link')).toBe(linkToken('ok'));
  });

  it('forgets everything on sign-out', async () => {
    apiClient.post.mockResolvedValueOnce({ access: linkToken('one') }).mockResolvedValueOnce({ access: linkToken('two') });
    await getDocumentLink('/files/vid/link');
    clearDocumentLinks();
    expect(sessionStorage.getItem('documentLinks')).toBeNull();
    expect(await getDocumentLink('/files/vid/link')).toBe(linkToken('two'));
  });

  it('does not let a link signed before sign-out back into storage', async () => {
    let finish;
    apiClient.post.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
      .mockResolvedValueOnce({ access: linkToken('next') });
    const pending = getDocumentLink('/files/vid/link');
    clearDocumentLinks();
    finish({ access: linkToken('old') });
    await pending;
    expect(sessionStorage.getItem('documentLinks') || '').not.toContain(linkToken('old'));
    expect(await getDocumentLink('/files/vid/link')).toBe(linkToken('next'));
  });

  it('makes others wait for a renewal rather than hand out the link that failed', async () => {
    let finish;
    apiClient.post.mockResolvedValueOnce({ access: linkToken('failed') })
      .mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await getDocumentLink('/files/vid/link');
    const renewal = getDocumentLink('/files/vid/link', { fresh: true });
    const other = getDocumentLink('/files/vid/link');
    finish({ access: linkToken('renewed') });
    expect(await renewal).toBe(linkToken('renewed'));
    expect(await other).toBe(linkToken('renewed'));
    expect(apiClient.post).toHaveBeenCalledTimes(2);
  });
});
