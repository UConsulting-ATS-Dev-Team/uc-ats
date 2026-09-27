import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

import { classifyResponse, requestMetrics } from './requestMetrics.js';
import { requestSamples, securityEvents } from './sinks.js';

vi.mock('./sinks.js', () => ({
  requestSamples: { push: vi.fn() },
  securityEvents: { push: vi.fn() },
}));

let server;
let base;
let currentUser = null;

beforeAll(async () => {
  const app = express();
  app.use((req, res, next) => {
    if (currentUser) req.user = currentUser;
    next();
  });
  app.use(requestMetrics);
  app.get('/api/admin/stats', (req, res) => res.status(req.user?.role === 'ADMIN' ? 200 : 403).json({}));
  app.get('/api/applications/:id', (req, res) => res.status(423).json({ code: 'RECORD_LOCKED' }));
  app.get('/api/secure', (req, res) => res.status(401).json({}));
  app.get('/api/health', (req, res) => res.json({}));
  app.post('/api/analytics/events', (req, res) => res.status(202).end());
  app.use((req, res) => res.status(404).end());
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  requestSamples.push.mockReset();
  securityEvents.push.mockReset();
  currentUser = null;
  delete process.env.ANALYTICS_DISABLED;
});

// res.on('finish') runs after the response is sent; give it a tick.
const settle = () => new Promise((r) => setTimeout(r, 20));
const call = async (path, init) => {
  await fetch(`${base}${path}`, init);
  await settle();
};
const kinds = () => securityEvents.push.mock.calls.map(([r]) => r.kind);

describe('requestMetrics', () => {
  it('records the normalized route, status, duration and role', async () => {
    currentUser = { id: 'u1', role: 'ADMIN' };
    await call('/api/admin/stats?cycle=5');
    expect(requestSamples.push).toHaveBeenCalledTimes(1);
    const [row] = requestSamples.push.mock.calls[0];
    expect(row).toMatchObject({ method: 'GET', route: '/api/admin/stats', status: 200, role: 'ADMIN', userId: 'u1' });
    expect(Number.isInteger(row.durationMs)).toBe(true);
  });

  it('replaces ids in the stored route', async () => {
    await call('/api/applications/3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b');
    expect(requestSamples.push.mock.calls[0][0].route).toBe('/api/applications/:id');
  });

  it('skips the ingestion endpoint and the health check', async () => {
    await call('/api/analytics/events', { method: 'POST' });
    await call('/api/health');
    expect(requestSamples.push).not.toHaveBeenCalled();
  });

  it('turns a candidate reaching an admin route into a ROLE_DENIED warning', async () => {
    currentUser = { id: 'u2', role: 'USER', isExternalTalent: false };
    await call('/api/admin/stats');
    const [row] = securityEvents.push.mock.calls[0];
    expect(row).toMatchObject({ kind: 'ROLE_DENIED', severity: 'WARN', role: 'CANDIDATE', status: 403 });
  });

  it('records a sealed record refusal', async () => {
    currentUser = { id: 'u3', role: 'MEMBER' };
    await call('/api/applications/abc');
    expect(kinds()).toEqual(['RECORD_LOCKED']);
  });

  it('records a 401 only when a token was sent', async () => {
    await call('/api/secure');
    expect(kinds()).toEqual([]);
    await call('/api/secure', { headers: { Authorization: 'Bearer expired' } });
    expect(kinds()).toEqual(['AUTH_DENIED']);
  });

  it('flags scanner paths outside the API too', async () => {
    await call('/wp-login.php');
    expect(kinds()).toEqual(['PATH_PROBE']);
    expect(requestSamples.push).not.toHaveBeenCalled();
  });

  it('does nothing when switched off', async () => {
    process.env.ANALYTICS_DISABLED = '1';
    await call('/wp-login.php');
    expect(securityEvents.push).not.toHaveBeenCalled();
  });

  it('never fails a request when recording throws', async () => {
    requestSamples.push.mockImplementation(() => {
      throw new Error('boom');
    });
    currentUser = { id: 'u1', role: 'ADMIN' };
    const res = await fetch(`${base}/api/admin/stats`);
    expect(res.status).toBe(200);
  });
});

describe('classifyResponse', () => {
  const base = { method: 'GET', hasToken: true };

  it('keeps a candidate denied their own-record route at INFO', () => {
    expect(classifyResponse({ ...base, path: '/api/applications/x', status: 403, role: 'CANDIDATE' })).toEqual([
      { kind: 'ROLE_DENIED', severity: 'INFO' },
    ]);
  });

  it('warns on any 403 to a partner client', () => {
    expect(classifyResponse({ ...base, path: '/api/member/events', status: 403, role: 'CLIENT' })[0].severity).toBe('WARN');
  });

  it('leaves failed sign-ins to the login route', () => {
    expect(classifyResponse({ ...base, path: '/api/auth/login', status: 401, role: 'ANON' })).toEqual([]);
  });

  it('raises a guard bypass for an impossible success', () => {
    const [event] = classifyResponse({ ...base, path: '/api/admin/stats', status: 200, role: 'MEMBER' });
    expect(event).toMatchObject({ kind: 'GUARD_BYPASS_SUSPECT', severity: 'CRITICAL' });
  });

  it('warns on 429', () => {
    expect(classifyResponse({ ...base, path: '/api/exec-access/unlock', status: 429, role: 'MEMBER' })).toEqual([
      { kind: 'RATE_LIMITED', severity: 'WARN' },
    ]);
  });
});
