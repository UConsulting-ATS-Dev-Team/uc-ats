// The sync token an admin generates instead of setting LUMA_SYNC_TOKEN by hand.
//
// The thing worth pinning down is that generating one never takes the other
// away: the stored token and the environment token are two ways to configure
// the same sync, and a deployment part-way through the move has both.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import prisma from '../../prismaClient.js';
import {
  MIN_TOKEN_LENGTH,
  acceptedSyncTokens,
  clearSyncToken,
  generateSyncToken,
  getSyncTokenState,
  rotateSyncToken
} from './syncToken.js';

vi.mock('../../prismaClient.js', () => ({
  default: { lumaSyncSetting: { findUnique: vi.fn(), upsert: vi.fn() } }
}));

const STORED = 'stored-token-long-enough-to-be-accepted-0';
const FROM_ENV = 'env-token-long-enough-to-be-accepted-000';

const row = (token) => ({
  token,
  tokenSetAt: new Date('2026-09-24T12:00:00.000Z'),
  updatedAt: new Date('2026-09-24T12:00:00.000Z'),
  updatedById: 'admin-1'
});

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.LUMA_SYNC_TOKEN;
  prisma.lumaSyncSetting.findUnique.mockResolvedValue(null);
  // Prisma answers an upsert with the row it wrote, and rotate now reports
  // from that rather than reading again.
  prisma.lumaSyncSetting.upsert.mockImplementation(({ create }) => Promise.resolve(create));
});

afterEach(() => {
  delete process.env.LUMA_SYNC_TOKEN;
});

describe('generateSyncToken', () => {
  it('is long enough to be accepted, and different every time', () => {
    const first = generateSyncToken();
    const second = generateSyncToken();
    expect(first.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH);
    expect(first).not.toBe(second);
  });

  // It travels in an Authorization header and through a prompt somebody pastes,
  // so it must survive both without escaping.
  it('is url-safe', () => {
    expect(generateSyncToken()).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('acceptedSyncTokens', () => {
  it('is empty when nothing is configured, which is what makes the endpoints 503', async () => {
    expect(await acceptedSyncTokens()).toEqual([]);
  });

  it('accepts the stored token', async () => {
    prisma.lumaSyncSetting.findUnique.mockResolvedValue(row(STORED));
    expect(await acceptedSyncTokens()).toEqual([STORED]);
  });

  it('accepts the environment token with no row at all', async () => {
    process.env.LUMA_SYNC_TOKEN = FROM_ENV;
    expect(await acceptedSyncTokens()).toEqual([FROM_ENV]);
  });

  it('accepts both at once rather than letting either win', async () => {
    process.env.LUMA_SYNC_TOKEN = FROM_ENV;
    prisma.lumaSyncSetting.findUnique.mockResolvedValue(row(STORED));
    expect(await acceptedSyncTokens()).toEqual([STORED, FROM_ENV]);
  });

  it('ignores a stored value too short to be anything but a placeholder', async () => {
    prisma.lumaSyncSetting.findUnique.mockResolvedValue(row('short'));
    expect(await acceptedSyncTokens()).toEqual([]);
  });

  it('ignores a short environment value the same way', async () => {
    process.env.LUMA_SYNC_TOKEN = 'short';
    expect(await acceptedSyncTokens()).toEqual([]);
  });

  // Migrations here are applied by hand, so the table can genuinely be absent.
  it('falls back to the environment when the table is missing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.LUMA_SYNC_TOKEN = FROM_ENV;
    prisma.lumaSyncSetting.findUnique.mockRejectedValue(
      Object.assign(new Error('missing'), { code: 'P2021' })
    );
    expect(await acceptedSyncTokens()).toEqual([FROM_ENV]);
  });

  it('propagates any other database failure rather than reading as unconfigured', async () => {
    prisma.lumaSyncSetting.findUnique.mockRejectedValue(new Error('connection lost'));
    await expect(acceptedSyncTokens()).rejects.toThrow('connection lost');
  });
});

describe('getSyncTokenState', () => {
  it('reports nothing configured when it is not', async () => {
    expect(await getSyncTokenState()).toMatchObject({
      token: null,
      configured: false,
      envTokenSet: false
    });
  });

  // The panel needs to say that syncing already works, so that generating a
  // token does not look like the only way to get started.
  it('reports an environment token without inventing one to show', async () => {
    process.env.LUMA_SYNC_TOKEN = FROM_ENV;
    expect(await getSyncTokenState()).toMatchObject({
      token: null,
      envTokenSet: true,
      configured: true
    });
  });

  it('returns the stored token, because the admin has to paste it', async () => {
    prisma.lumaSyncSetting.findUnique.mockResolvedValue(row(STORED));
    const state = await getSyncTokenState();
    expect(state.token).toBe(STORED);
    expect(state.configured).toBe(true);
    expect(state.tokenSetAt).toEqual(new Date('2026-09-24T12:00:00.000Z'));
  });

  it('does not report a too-short stored value as a token', async () => {
    prisma.lumaSyncSetting.findUnique.mockResolvedValue(row('short'));
    expect(await getSyncTokenState()).toMatchObject({ token: null, configured: false });
  });
});

describe('rotateSyncToken', () => {
  it('stores a new token and records who did it', async () => {
    const state = await rotateSyncToken('admin-1');
    const { create } = prisma.lumaSyncSetting.upsert.mock.calls[0][0];

    expect(create.token.length).toBeGreaterThanOrEqual(MIN_TOKEN_LENGTH);
    expect(create.updatedById).toBe('admin-1');
    expect(state.token).toBe(create.token);
  });

  // The old token is dead the moment the write lands. Reporting from a second
  // read would let a read failure answer "could not generate" about a rotation
  // that did happen, leaving the routine on a token nobody can see.
  it('reports from the write, so it never needs a second read', async () => {
    prisma.lumaSyncSetting.findUnique.mockRejectedValue(new Error('read failed'));
    const state = await rotateSyncToken('admin-1');
    expect(state.token).toBeTruthy();
    expect(prisma.lumaSyncSetting.findUnique).not.toHaveBeenCalled();
  });

  it('replaces the previous one rather than adding a second', async () => {
    prisma.lumaSyncSetting.findUnique.mockResolvedValue(row(STORED));
    await rotateSyncToken('admin-1');
    const { update } = prisma.lumaSyncSetting.upsert.mock.calls[0][0];
    expect(update.token).toBeTruthy();
    expect(update.token).not.toBe(STORED);
  });
});

describe('clearSyncToken', () => {
  it('nulls the stored token', async () => {
    await clearSyncToken('admin-1');
    const { update } = prisma.lumaSyncSetting.upsert.mock.calls[0][0];
    expect(update).toMatchObject({ token: null, tokenSetAt: null, updatedById: 'admin-1' });
  });

  // Clearing is an ATS action; it cannot reach into the server's environment,
  // and saying otherwise in the UI would be a lie about what still works.
  it('leaves the environment token alone', async () => {
    process.env.LUMA_SYNC_TOKEN = FROM_ENV;
    const state = await clearSyncToken('admin-1');
    expect(state).toMatchObject({ token: null, envTokenSet: true, configured: true });
  });

  it('reports from the write here too', async () => {
    prisma.lumaSyncSetting.findUnique.mockRejectedValue(new Error('read failed'));
    await expect(clearSyncToken('admin-1')).resolves.toMatchObject({ token: null });
  });
});
