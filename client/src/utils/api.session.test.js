// apiClient signs a person out only when the server says the session is dead
// (401 + SESSION_INVALID), and only for the token the request carried. The
// request itself must fail exactly as before either way.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import apiClient from './api';
import { resetTracker } from '../analytics/tracker';

const jsonResponse = (status, body) => ({
  ok: status < 400,
  status,
  statusText: 'x',
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
});

const sessionInvalid = () => jsonResponse(401, { error: 'Invalid token', code: 'SESSION_INVALID' });

let handler;

beforeEach(() => {
  resetTracker();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  handler = vi.fn();
  apiClient.setSessionExpiredHandler(handler);
  apiClient.setToken('token-a');
});

afterEach(() => {
  apiClient.setSessionExpiredHandler(null);
  apiClient.setToken(null);
  vi.restoreAllMocks();
});

describe('apiClient session expiry', () => {
  it('calls the handler on a 401 with SESSION_INVALID, and still throws', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(sessionInvalid()));
    await expect(apiClient.get('/live-votes/active')).rejects.toMatchObject({
      status: 401,
      code: 'SESSION_INVALID',
      serverMessage: 'Invalid token',
    });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('ignores a 401 without the code, which is what an old server sends', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(401, { error: 'Invalid token' })));
    await expect(apiClient.get('/live-votes/active')).rejects.toMatchObject({ status: 401 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores a wrong password on /auth/login', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(401, { error: 'Invalid credentials' })));
    await expect(apiClient.post('/auth/login', { email: 'a@ucla.edu', password: 'x' })).rejects.toMatchObject({
      status: 401,
      serverMessage: 'Invalid credentials',
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores SESSION_INVALID on a request sent with no token', async () => {
    apiClient.setToken(null);
    globalThis.fetch = vi.fn(() => Promise.resolve(sessionInvalid()));
    await expect(apiClient.get('/live-votes/active')).rejects.toMatchObject({ status: 401 });
    expect(handler).not.toHaveBeenCalled();
  });

  it('ignores a late 401 from a session that has since been replaced', async () => {
    let answer;
    globalThis.fetch = vi.fn(() => new Promise((resolve) => { answer = resolve; }));
    const pending = apiClient.get('/live-votes/active');
    // The person signs in again while the old request is still in flight.
    apiClient.setToken('token-b');
    answer(sessionInvalid());
    await expect(pending).rejects.toMatchObject({ status: 401, code: 'SESSION_INVALID' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('signs out once for a burst of failing requests when the handler clears the token', async () => {
    handler.mockImplementation(() => apiClient.setToken(null));
    globalThis.fetch = vi.fn(() => Promise.resolve(sessionInvalid()));
    const results = await Promise.allSettled([
      apiClient.get('/live-votes/active'),
      apiClient.get('/review-delibs/active'),
      apiClient.get('/admin/stats'),
    ]);
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(results.every((r) => r.reason.code === 'SESSION_INVALID')).toBe(true);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does nothing extra when no handler is registered', async () => {
    apiClient.setSessionExpiredHandler(null);
    globalThis.fetch = vi.fn(() => Promise.resolve(sessionInvalid()));
    await expect(apiClient.get('/live-votes/active')).rejects.toMatchObject({ status: 401 });
  });
});
