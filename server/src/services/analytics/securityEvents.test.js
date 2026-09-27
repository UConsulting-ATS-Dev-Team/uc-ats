import { describe, it, expect, vi, beforeEach } from 'vitest';

import { isPathProbe, recordLoginFailed, recordLoginOk, resetLoginWindows } from './securityEvents.js';
import { securityEvents } from './sinks.js';

vi.mock('./sinks.js', () => ({ securityEvents: { push: vi.fn() } }));

const kinds = () => securityEvents.push.mock.calls.map(([row]) => row.kind);
const bruteForce = () => securityEvents.push.mock.calls.map(([row]) => row).filter((r) => r.kind === 'BRUTE_FORCE');

const T0 = Date.UTC(2026, 8, 27, 12, 0, 0);
const MIN = 60_000;

beforeEach(() => {
  securityEvents.push.mockClear();
  resetLoginWindows();
});

describe('recordLoginFailed', () => {
  it('records each failure with the lowercased address', () => {
    recordLoginFailed({ email: ' Joe@UCLA.edu ', ip: '1.2.3.4', reason: 'wrong_password', now: T0 });
    const [row] = securityEvents.push.mock.calls[0];
    expect(row).toMatchObject({ kind: 'LOGIN_FAILED', severity: 'INFO', role: 'ANON', ip: '1.2.3.4', status: 401 });
    expect(row.detail).toEqual({ email: 'joe@ucla.edu', reason: 'wrong_password' });
  });

  it('raises one BRUTE_FORCE at the fifth failure from one IP within 15 minutes', () => {
    for (let i = 0; i < 4; i += 1) recordLoginFailed({ email: `u${i}@x.edu`, ip: '9.9.9.9', reason: 'r', now: T0 + i * MIN });
    expect(bruteForce()).toHaveLength(0);
    recordLoginFailed({ email: 'u5@x.edu', ip: '9.9.9.9', reason: 'r', now: T0 + 5 * MIN });
    expect(bruteForce()).toHaveLength(1);
    expect(bruteForce()[0]).toMatchObject({ severity: 'CRITICAL', detail: { by: 'ip', value: '9.9.9.9', failures: 5 } });
  });

  it('does not raise it again for the same attack', () => {
    for (let i = 0; i < 9; i += 1) recordLoginFailed({ email: `u${i}@x.edu`, ip: '9.9.9.9', reason: 'r', now: T0 + i * MIN });
    expect(bruteForce()).toHaveLength(1);
  });

  it('raises it again once the window has passed', () => {
    for (let i = 0; i < 5; i += 1) recordLoginFailed({ email: `a${i}@x.edu`, ip: '9.9.9.9', reason: 'r', now: T0 + i * MIN });
    for (let i = 0; i < 5; i += 1) recordLoginFailed({ email: `b${i}@x.edu`, ip: '9.9.9.9', reason: 'r', now: T0 + 60 * MIN + i * MIN });
    expect(bruteForce()).toHaveLength(2);
  });

  it('spreads over IPs are still caught by the address', () => {
    for (let i = 0; i < 5; i += 1) recordLoginFailed({ email: 'target@ucla.edu', ip: `10.0.0.${i}`, reason: 'r', now: T0 + i * MIN });
    expect(bruteForce()).toHaveLength(1);
    expect(bruteForce()[0].detail).toMatchObject({ by: 'email', value: 'target@ucla.edu' });
  });

  it('spreads over time are not', () => {
    for (let i = 0; i < 5; i += 1) recordLoginFailed({ email: 'slow@ucla.edu', ip: '1.1.1.1', reason: 'r', now: T0 + i * 20 * MIN });
    expect(bruteForce()).toHaveLength(0);
  });
});

describe('recordLoginOk', () => {
  it('records the user and role', () => {
    recordLoginOk({ user: { id: 'u1', role: 'MEMBER' }, ip: '1.1.1.1' });
    expect(securityEvents.push.mock.calls[0][0]).toMatchObject({ kind: 'LOGIN_OK', userId: 'u1', role: 'MEMBER' });
    expect(kinds()).toEqual(['LOGIN_OK']);
  });
});

describe('isPathProbe', () => {
  it.each(['/wp-login.php', '/.env', '/.git/config', '/phpmyadmin/', '/api/../../etc/passwd', '/cgi-bin/x', '/backup.sql'])(
    'flags %s',
    (path) => expect(isPathProbe(path)).toBe(true)
  );

  it.each(['/api/admin/stats', '/api/member/interviews/:id/config', '/admin/analytics', '/api/files/:id'])('leaves %s alone', (path) =>
    expect(isPathProbe(path)).toBe(false)
  );
});
