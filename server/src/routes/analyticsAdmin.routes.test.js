import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

import routes from './analyticsAdmin.js';
import { errors, overview, performance } from '../services/analytics/queries.js';
import { runRollup } from '../services/analytics/rollup.js';
import { email, engagement } from '../services/analytics/engagementQueries.js';
import { security } from '../services/analytics/securityQueries.js';

vi.mock('../services/analytics/queries.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, overview: vi.fn(), performance: vi.fn(), errors: vi.fn() };
});
vi.mock('../services/analytics/rollup.js', () => ({ runRollup: vi.fn() }));
vi.mock('../services/analytics/engagementQueries.js', () => ({ engagement: vi.fn(), email: vi.fn() }));
vi.mock('../services/analytics/securityQueries.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, security: vi.fn() };
});
vi.mock('../prismaClient.js', () => ({ default: {} }));

let server;
let base;

beforeAll(async () => {
  const app = express();
  app.use('/api/admin/analytics', routes);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  vi.clearAllMocks();
});

const get = (path) => fetch(`${base}/api/admin/analytics${path}`);

describe('analytics admin routes', () => {
  it('clamps days to 7, 30 or 90', async () => {
    overview.mockResolvedValue({ ok: true });
    await get('/overview?days=7');
    await get('/overview?days=365');
    await get('/overview');
    expect(overview.mock.calls.map(([d]) => d)).toEqual([7, 30, 30]);
  });

  it('passes a known role through and anything else as ALL', async () => {
    performance.mockResolvedValue({});
    await get('/performance?days=90&role=MEMBER');
    await get('/performance?role=root');
    expect(performance.mock.calls).toEqual([
      [90, 'MEMBER'],
      [30, 'ALL'],
    ]);
  });

  it('returns what the service returns', async () => {
    errors.mockResolvedValue({ server: [{ fingerprint: 'f' }] });
    const res = await get('/errors?days=7');
    expect(await res.json()).toEqual({ server: [{ fingerprint: 'f' }] });
  });

  it('hides internals on failure', async () => {
    overview.mockRejectedValue(new Error('relation "analytics_daily_summaries" does not exist'));
    const res = await get('/overview');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'Could not load analytics' });
  });

  it('serves engagement by user type and email for the range', async () => {
    engagement.mockResolvedValue({});
    email.mockResolvedValue({ trackingActive: false });
    await get('/engagement?days=7&role=CANDIDATE');
    const res = await get('/email?days=90');
    expect(engagement).toHaveBeenCalledWith(7, 'CANDIDATE');
    expect(email).toHaveBeenCalledWith(90);
    expect(await res.json()).toEqual({ trackingActive: false });
  });

  it('passes only known security filters through', async () => {
    security.mockResolvedValue({});
    await get('/security?kind=LOGIN_FAILED&role=ANON&ip=10.0.0.1&page=2&execPage=1');
    await get("/security?kind=DROP TABLE&role=root&ip=1.1.1.1';--&page=-4&execPage=x");
    expect(security.mock.calls).toEqual([
      [30, { kind: 'LOGIN_FAILED', role: 'ANON', ip: '10.0.0.1', page: 2, execPage: 1 }],
      [30, { kind: null, role: null, ip: null, page: 0, execPage: 0 }],
    ]);
  });

  it('runs a rollup on demand', async () => {
    runRollup.mockResolvedValue({ days: ['2026-09-26', '2026-09-25'] });
    const res = await fetch(`${base}/api/admin/analytics/rollup`, { method: 'POST' });
    expect(await res.json()).toEqual({ days: ['2026-09-26', '2026-09-25'] });
  });

  it('answers 409 while a rollup is already running', async () => {
    runRollup.mockResolvedValue(null);
    const res = await fetch(`${base}/api/admin/analytics/rollup`, { method: 'POST' });
    expect(res.status).toBe(409);
  });
});
