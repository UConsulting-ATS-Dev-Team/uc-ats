// apiClient reports failed and slow calls to Site Analytics. The request
// itself must behave exactly as before: same errors thrown, same values returned.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import apiClient from './api';
import { queuedEvents, resetTracker } from '../analytics/tracker';

const jsonResponse = (status, body) => ({
  ok: status < 400,
  status,
  statusText: 'x',
  json: () => Promise.resolve(body),
  text: () => Promise.resolve(JSON.stringify(body)),
});

beforeEach(() => {
  resetTracker();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

const events = (type) => queuedEvents().filter((e) => e.type === type);

describe('apiClient analytics', () => {
  it('reports a network failure as status 0 and rethrows it', async () => {
    globalThis.fetch = vi.fn(() => Promise.reject(new TypeError('Failed to fetch')));
    await expect(apiClient.get('/admin/cycles/42')).rejects.toThrow('Failed to fetch');
    expect(events('api_error')[0]).toMatchObject({ path: '/admin/cycles/:id', name: '0', meta: { method: 'GET', network: true } });
  });

  it('reports a failed response with its status and code', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(423, { error: 'Locked', code: 'RECORD_LOCKED' })));
    await expect(apiClient.post('/applications/9', {})).rejects.toMatchObject({ status: 423, code: 'RECORD_LOCKED' });
    expect(events('api_error')[0]).toMatchObject({ path: '/applications/:id', name: '423', meta: { method: 'POST', code: 'RECORD_LOCKED' } });
  });

  it('does not report an expired session bouncing off /auth', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(401, { error: 'expired' })));
    await expect(apiClient.get('/auth/verify')).rejects.toBeTruthy();
    expect(events('api_error')).toHaveLength(0);
  });

  it('reports a call slower than two seconds', async () => {
    let t = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      t += 2500;
      return t;
    });
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { ok: true })));
    await expect(apiClient.get('/admin/stats')).resolves.toEqual({ ok: true });
    expect(events('api_slow')[0]).toMatchObject({ path: '/admin/stats', value: 2500 });
  });

  it('reports nothing for a fast success', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { ok: true })));
    await apiClient.get('/admin/stats');
    expect(queuedEvents()).toHaveLength(0);
  });
});
