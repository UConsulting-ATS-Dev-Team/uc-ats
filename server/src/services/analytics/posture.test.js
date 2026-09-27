import { describe, it, expect, vi } from 'vitest';

import { runPostureChecks } from './posture.js';
import { isExecPasswordConfigured } from '../execAccess.js';
import { getSyncTokenState } from '../luma/syncToken.js';

vi.mock('../../prismaClient.js', () => ({ default: {} }));
vi.mock('../execAccess.js', () => ({ isExecPasswordConfigured: vi.fn(async () => true) }));
vi.mock('../luma/syncToken.js', () => ({ getSyncTokenState: vi.fn(async () => ({ configured: false })) }));

const STRONG = 'k'.repeat(48);
const good = {
  NODE_ENV: 'production',
  JWT_SECRET: STRONG,
  LIVE_VOTE_SECRET: STRONG,
  UNSUBSCRIBE_SECRET: STRONG,
  MEMBER_REGISTRATION_TOKEN: 'member-token-long-enough',
  SES_CONFIGURATION_SET: 'set',
  SES_SNS_TOPIC_ARN: 'arn',
  DIRECT_URL: 'postgres://x',
};
const client = (admins = [{ email: 'a', isActive: true }], unreachable = 0) => ({
  user: { findMany: vi.fn(async () => admins), count: vi.fn(async () => unreachable) },
});
const run = (env, opts = {}) =>
  runPostureChecks({ env: { ...good, ...env }, cfg: { corsOrigin: opts.cors || ['https://uconsultingats.com'] }, client: opts.client || client() });
const status = (checks, key) => checks.find((c) => c.key === key).status;

describe('runPostureChecks', () => {
  it('passes a well-configured production deployment', async () => {
    const checks = await run({});
    for (const key of ['jwt_secret', 'live_vote_secret', 'unsubscribe_secret', 'member_registration_token', 'cors_origin', 'node_env', 'ses_events', 'exec_password']) {
      expect(status(checks, key)).toBe('PASS');
    }
  });

  it('fails a short or placeholder JWT secret', async () => {
    expect(status(await run({ JWT_SECRET: 'changeme' }), 'jwt_secret')).toBe('FAIL');
    expect(status(await run({ JWT_SECRET: 'short-but-real-1234' }), 'jwt_secret')).toBe('WARN');
  });

  it('warns when secrets fall back to the JWT secret', async () => {
    const checks = await run({ LIVE_VOTE_SECRET: undefined, UNSUBSCRIBE_SECRET: undefined });
    expect(status(checks, 'live_vote_secret')).toBe('WARN');
    expect(status(checks, 'unsubscribe_secret')).toBe('WARN');
  });

  it('fails a wildcard CORS origin and warns on plain HTTP in production', async () => {
    expect(status(await run({}, { cors: ['*'] }), 'cors_origin')).toBe('FAIL');
    expect(status(await run({}, { cors: ['http://ats.test'] }), 'cors_origin')).toBe('WARN');
  });

  it('warns when SES delivery reporting is not wired up', async () => {
    expect(status(await run({ SES_SNS_TOPIC_ARN: undefined }), 'ses_events')).toBe('WARN');
  });

  it('warns about too many admins and names deactivated ones', async () => {
    const admins = [...Array(9)].map(() => ({ email: 'x', isActive: true })).concat({ email: 'y', isActive: false });
    const check = (await run({}, { client: client(admins) })).find((c) => c.key === 'admin_accounts');
    expect(check.status).toBe('WARN');
    expect(check.detail).toContain('1 deactivated');
  });

  it('reports a check that cannot run as UNKNOWN without hiding the rest', async () => {
    isExecPasswordConfigured.mockRejectedValueOnce(new Error('db down'));
    getSyncTokenState.mockRejectedValueOnce(new Error('db down'));
    const checks = await run({});
    expect(status(checks, 'exec_password')).toBe('UNKNOWN');
    expect(status(checks, 'jwt_secret')).toBe('PASS');
  });

  it('puts failures first', async () => {
    const checks = await run({ JWT_SECRET: 'changeme' });
    expect(checks[0].status).toBe('FAIL');
  });
});
