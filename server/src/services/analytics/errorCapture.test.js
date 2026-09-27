import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';

import {
  describeArgs,
  expressErrorHandler,
  fingerprint,
  installErrorCapture,
  recordServerError,
  uninstallErrorCapture,
} from './errorCapture.js';
import { recordSecurityEvent } from './securityEvents.js';
import { serverErrors } from './sinks.js';

// A buffer stand-in that keeps rows, so `has` and in-place count bumps behave.
vi.mock('./sinks.js', () => {
  const rows = [];
  return {
    serverErrors: {
      rows,
      push: vi.fn((row) => rows.push(row)),
      has: (row) => rows.includes(row),
      flush: vi.fn(),
    },
  };
});
vi.mock('./securityEvents.js', () => ({ recordSecurityEvent: vi.fn() }));
vi.mock('./log.js', () => ({ logError: vi.fn() }));
vi.mock('./buffer.js', () => ({ flushAll: vi.fn(() => Promise.resolve()), sleep: () => new Promise(() => {}) }));

const rows = () => serverErrors.rows;
const realConsoleError = console.error;

afterAll(() => {
  console.error = realConsoleError;
});

beforeEach(() => {
  serverErrors.rows.length = 0;
  serverErrors.push.mockClear();
  recordSecurityEvent.mockClear();
});

afterEach(() => {
  uninstallErrorCapture();
});

describe('fingerprint', () => {
  it('ignores ids, numbers and quoted values', () => {
    const a = fingerprint('Candidate 3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b not found in cycle 12 "Fall"');
    const b = fingerprint('Candidate 11111111-2222-4333-8444-555555555555 not found in cycle 7 "Spring"');
    expect(a).toBe(b);
  });

  it('separates the same message on different routes', () => {
    expect(fingerprint('boom', '/api/a')).not.toBe(fingerprint('boom', '/api/b'));
  });
});

describe('describeArgs', () => {
  it('joins strings and error messages and keeps the stack', () => {
    const err = new Error('connection refused');
    const out = describeArgs(['[GET /api/x]', err]);
    expect(out.message).toBe('[GET /api/x] connection refused');
    expect(out.stack).toContain('connection refused');
  });
});

describe('recordServerError', () => {
  it('folds repeats inside a minute into one row', () => {
    recordServerError({ source: 'console', message: 'db timeout after 5000ms', now: 1_000 });
    recordServerError({ source: 'console', message: 'db timeout after 6000ms', now: 20_000 });
    expect(rows()).toHaveLength(1);
    expect(rows()[0].count).toBe(2);
  });

  it('starts a new row after the minute, or once the first was written', () => {
    recordServerError({ source: 'console', message: 'x', now: 1_000 });
    recordServerError({ source: 'console', message: 'x', now: 70_000 });
    expect(rows()).toHaveLength(2);
    serverErrors.rows.length = 0; // "flushed"
    recordServerError({ source: 'console', message: 'x', now: 71_000 });
    expect(rows()).toHaveLength(1);
  });

  it('redacts addresses and tokens in the message', () => {
    recordServerError({ source: 'console', message: 'no user joe@ucla.edu for /reset?token=abc123', now: 1 });
    expect(rows()[0].message).toBe('no user [email] for /reset?token=[redacted]');
  });
});

describe('installErrorCapture', () => {
  it('still prints, and records what was printed', () => {
    const printed = vi.fn();
    console.error = printed;
    installErrorCapture();
    console.error('[POST /api/x]', new Error('bad thing'));
    expect(printed).toHaveBeenCalledWith('[POST /api/x]', expect.any(Error));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({ source: 'console', message: '[POST /api/x] bad thing' });
  });

  it('restores console.error on uninstall', () => {
    const printed = vi.fn();
    console.error = printed;
    installErrorCapture();
    uninstallErrorCapture();
    expect(console.error).toBe(printed);
  });

  it('does not capture its own failures', () => {
    const printed = vi.fn();
    console.error = printed;
    installErrorCapture();
    // A console.error from inside capture (e.g. the buffer logging a failure
    // while a row is being recorded) is printed once and not captured.
    serverErrors.push.mockImplementationOnce(() => console.error('nested'));
    console.error('outer');
    expect(printed).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(0);
  });

  it('ignores Prisma failures writing the analytics tables', () => {
    console.error = vi.fn();
    installErrorCapture();
    console.error('prisma:error Invalid `prisma.serverErrorLog.createMany()` invocation: table server_error_logs does not exist');
    expect(rows()).toHaveLength(0);
  });

  it('ignores the auth middleware logging a bad token, which is not a server failure', () => {
    console.error = vi.fn();
    installErrorCapture();
    console.error('Auth middleware error:', new Error('invalid token'));
    expect(rows()).toHaveLength(0);
  });

  it('records an unhandled rejection and still exits', async () => {
    console.error = vi.fn();
    const exit = vi.fn();
    installErrorCapture({ exit });
    // Called directly: emitting the real event would reach vitest's own listener.
    const listener = process.listeners('unhandledRejection').at(-1);
    listener(new Error('nobody caught me'));
    await new Promise((r) => setTimeout(r, 0));
    expect(rows()[0]).toMatchObject({ source: 'unhandled', message: 'unhandledRejection: nobody caught me' });
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('expressErrorHandler', () => {
  const res = () => {
    const r = { headersSent: false };
    r.status = vi.fn(() => r);
    r.json = vi.fn(() => r);
    return r;
  };
  const req = { method: 'GET', originalUrl: '/api/applications/42?x=1', headers: { origin: 'https://evil.example' }, ip: '1.2.3.4' };

  it('answers 500 JSON without the message and records it', () => {
    const r = res();
    expressErrorHandler(new Error('secret internals'), req, r, vi.fn());
    expect(r.status).toHaveBeenCalledWith(500);
    expect(r.json).toHaveBeenCalledWith({ error: 'Internal server error' });
    expect(rows()[0]).toMatchObject({ source: 'request', route: '/api/applications/:id', status: 500 });
  });

  it('honours a status the error carries and does not record a 4xx', () => {
    const r = res();
    expressErrorHandler(Object.assign(new Error('Too large'), { status: 413 }), req, r, vi.fn());
    expect(r.status).toHaveBeenCalledWith(413);
    expect(r.json).toHaveBeenCalledWith({ error: 'Too large' });
    expect(rows()).toHaveLength(0);
  });

  it('answers 400 for a body that is not JSON', () => {
    const r = res();
    expressErrorHandler(Object.assign(new Error('Unexpected token'), { type: 'entity.parse.failed' }), req, r, vi.fn());
    expect(r.status).toHaveBeenCalledWith(400);
  });

  it('answers 403 to a refused origin and records it', () => {
    const r = res();
    expressErrorHandler(new Error('Not allowed by CORS'), req, r, vi.fn());
    expect(r.status).toHaveBeenCalledWith(403);
    expect(recordSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'CORS_DENIED', detail: { origin: 'https://evil.example' } })
    );
  });

  it('hands over to Express once headers are out', () => {
    const r = { ...res(), headersSent: true };
    const next = vi.fn();
    const err = new Error('late');
    expressErrorHandler(err, req, r, next);
    expect(next).toHaveBeenCalledWith(err);
  });
});
