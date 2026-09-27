// The ingestion endpoint is public, so the tests are mostly about what it
// refuses: oversized batches, unknown types, long fields, and any attempt to
// claim an identity from the body.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

import routes from './analyticsIngest.js';
import { resetIngestLimits } from '../services/analytics/ingest.js';
import { clientEvents } from '../services/analytics/sinks.js';

vi.mock('../services/analytics/sinks.js', () => ({ clientEvents: { push: vi.fn() } }));

let server;
let base;
let currentUser = null;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use((req, res, next) => {
    if (currentUser) req.user = currentUser;
    next();
  });
  app.use('/api/analytics/events', routes);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  clientEvents.push.mockClear();
  resetIngestLimits();
  currentUser = null;
});

const SESSION = 'sess_abcdefgh1234';
const event = (overrides = {}) => ({ type: 'page_view', path: '/admin/analytics', ts: Date.now(), ...overrides });

const post = (body, contentType = 'text/plain') =>
  fetch(`${base}/api/analytics/events`, {
    method: 'POST',
    headers: { 'Content-Type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const pushed = () => clientEvents.push.mock.calls.map(([row]) => row);

describe('POST /api/analytics/events', () => {
  it('accepts a beacon-style text/plain body', async () => {
    const res = await post({ sessionId: SESSION, events: [event()] });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: 1, rejected: 0 });
    expect(pushed()[0]).toMatchObject({ type: 'page_view', path: '/admin/analytics', role: 'ANON', userId: null, sessionId: SESSION });
  });

  it('accepts JSON too', async () => {
    const res = await post({ sessionId: SESSION, events: [event()] }, 'application/json');
    expect(res.status).toBe(202);
  });

  it('takes identity from the session, never from the body', async () => {
    currentUser = { id: 'u-member', role: 'MEMBER' };
    await post({ sessionId: SESSION, events: [event({ role: 'ADMIN', userId: 'u-admin' })] });
    expect(pushed()[0]).toMatchObject({ role: 'MEMBER', userId: 'u-member' });
  });

  it('normalizes the path server-side', async () => {
    await post({ sessionId: SESSION, events: [event({ path: '/applications/3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b?token=x' })] });
    expect(pushed()[0].path).toBe('/applications/:id');
  });

  it('refuses a batch over 50 events', async () => {
    const res = await post({ sessionId: SESSION, events: Array.from({ length: 51 }, () => event()) });
    expect(res.status).toBe(400);
    expect(clientEvents.push).not.toHaveBeenCalled();
  });

  it('refuses a body without a usable session id', async () => {
    expect((await post({ sessionId: 'x', events: [] })).status).toBe(400);
    expect((await post('not json')).status).toBe(400);
  });

  it('drops bad events and keeps good ones', async () => {
    const res = await post({
      sessionId: SESSION,
      events: [
        event(),
        event({ type: 'steal_cookies' }),
        event({ path: `/${'a'.repeat(250)}` }),
        event({ name: 'x'.repeat(200) }),
        event({ value: 'fast' }),
        event({ meta: { blob: 'y'.repeat(2000) } }),
        event({ type: 'vital', name: 'LCP', value: 1234.5 }),
      ],
    });
    expect(await res.json()).toEqual({ accepted: 2, rejected: 5 });
  });

  it('masks addresses in labels', async () => {
    await post({ sessionId: SESSION, events: [event({ type: 'click', name: 'Email joe@ucla.edu' })] });
    expect(pushed()[0].name).toBe('Email [email]');
  });

  it('clamps a client clock that is far off', async () => {
    const before = Date.now();
    await post({ sessionId: SESSION, events: [event({ ts: 0 }), event({ ts: before + 10 * 60 * 60 * 1000 })] });
    const [old, future] = pushed();
    expect(old.at.getTime()).toBeGreaterThanOrEqual(before - 10 * 60 * 1000 - 1000);
    expect(future.at.getTime()).toBeLessThanOrEqual(Date.now() + 60 * 1000);
  });

  it('answers 429 after 60 batches from one address in a minute', async () => {
    for (let i = 0; i < 60; i += 1) {
      expect((await post({ sessionId: SESSION, events: [] })).status).toBe(202);
    }
    expect((await post({ sessionId: SESSION, events: [] })).status).toBe(429);
  });
});
