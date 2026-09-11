// The executive unlock is the only thing standing between a promoted member and
// their own recruiting file, so these pin down what it will and will not accept.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import {
  EXEC_ACCESS_ACTIONS,
  EXEC_UNLOCK_HEADER,
  FAILED_ATTEMPT_WINDOW_MS,
  MAX_FAILED_ATTEMPTS,
  clearFailedAttempts,
  isExecUnlocked,
  isRateLimited,
  issueUnlockToken,
  lockCandidateRecords,
  readUnlock,
  recordFailedAttempt,
  setExecPassword,
  verifyExecPassword
} from './execAccess.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    execAccessSetting: { findUnique: vi.fn(), upsert: vi.fn() },
    execAccessLog: { create: vi.fn() },
    candidate: { updateMany: vi.fn() }
  }
}));

const requestFrom = (userId, token) => ({
  user: userId ? { id: userId } : undefined,
  headers: token ? { [EXEC_UNLOCK_HEADER]: token } : {}
});

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('unlock tokens', () => {
  it('unlock the person they were issued to', () => {
    const { token } = issueUnlockToken('exec-1');
    expect(isExecUnlocked(requestFrom('exec-1', token))).toBe(true);
  });

  it('do not unlock anyone else who presents them', () => {
    const { token } = issueUnlockToken('exec-1');
    expect(isExecUnlocked(requestFrom('member-2', token))).toBe(false);
  });

  it('need a signed-in user, not just the header', () => {
    const { token } = issueUnlockToken('exec-1');
    expect(isExecUnlocked(requestFrom(null, token))).toBe(false);
  });

  // Both directions matter. An unlock must not work as a login, and a token signed
  // with JWT_SECRET - which every session token already is - must not work as an unlock.
  it('are not interchangeable with login tokens', () => {
    const { token } = issueUnlockToken('exec-1');
    expect(() => jwt.verify(token, process.env.JWT_SECRET)).toThrow();

    const forged = jwt.sign({ purpose: 'exec-unlock' }, process.env.JWT_SECRET, { subject: 'exec-1' });
    expect(isExecUnlocked(requestFrom('exec-1', forged))).toBe(false);
  });

  it('stop working once they expire', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-11T12:00:00Z'));
    const { token, expiresAt } = issueUnlockToken('exec-1');
    expect(expiresAt).toBe('2026-09-11T12:30:00.000Z');
    expect(readUnlock(requestFrom('exec-1', token))).toEqual({ expiresAt });

    vi.setSystemTime(new Date(Date.parse(expiresAt) + 1000));
    expect(isExecUnlocked(requestFrom('exec-1', token))).toBe(false);
  });

  it('treat garbage as no unlock rather than an error', () => {
    expect(isExecUnlocked(requestFrom('exec-1', 'not-a-token'))).toBe(false);
  });
});

describe('wrong guesses', () => {
  const now = 1_700_000_000_000;

  it('lock a user out after five inside the window, and only that user', () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS - 1; i++) recordFailedAttempt('guesser-a', now + i);
    expect(isRateLimited('guesser-a', now + 10)).toBe(false);

    recordFailedAttempt('guesser-a', now + 10);
    expect(isRateLimited('guesser-a', now + 11)).toBe(true);
    expect(isRateLimited('bystander', now + 11)).toBe(false);
  });

  it('are forgotten once the window passes', () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) recordFailedAttempt('guesser-b', now);
    expect(isRateLimited('guesser-b', now + 1)).toBe(true);
    expect(isRateLimited('guesser-b', now + FAILED_ATTEMPT_WINDOW_MS + 1)).toBe(false);
  });

  it('are forgotten after a correct password', () => {
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) recordFailedAttempt('guesser-c', now);
    clearFailedAttempts('guesser-c');
    expect(isRateLimited('guesser-c', now + 1)).toBe(false);
  });
});

describe('the executive password', () => {
  it('verifies nothing until one has been set', async () => {
    prisma.execAccessSetting.findUnique.mockResolvedValue(null);
    expect(await verifyExecPassword('anything at all')).toBe(false);
  });

  it('is checked against the stored hash', async () => {
    prisma.execAccessSetting.findUnique.mockResolvedValue({
      id: 'singleton',
      passwordHash: await bcrypt.hash('correct horse battery', 4)
    });
    expect(await verifyExecPassword('correct horse battery')).toBe(true);
    expect(await verifyExecPassword('wrong horse battery')).toBe(false);
    expect(await verifyExecPassword('')).toBe(false);
    expect(await verifyExecPassword(undefined)).toBe(false);
  });

  it('refuses a short replacement, stores only a hash, and audits the change', async () => {
    await expect(setExecPassword('short')).rejects.toMatchObject({ status: 400 });
    expect(prisma.execAccessSetting.upsert).not.toHaveBeenCalled();

    await setExecPassword('a long enough passphrase', { updatedById: 'exec-1' });
    const { create } = prisma.execAccessSetting.upsert.mock.calls[0][0];
    expect(create.passwordHash).not.toContain('passphrase');
    expect(await bcrypt.compare('a long enough passphrase', create.passwordHash)).toBe(true);
    expect(prisma.execAccessLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: EXEC_ACCESS_ACTIONS.PASSWORD_SET, userId: 'exec-1' })
    });
  });
});

describe('sealing a record', () => {
  it('audits the seal once, not on every repeat', async () => {
    prisma.candidate.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });

    expect(await lockCandidateRecords('cand-1', { userId: 'exec-1' })).toBe(true);
    expect(await lockCandidateRecords('cand-1', { userId: 'exec-1' })).toBe(false);

    expect(prisma.candidate.updateMany.mock.calls[0][0].where).toEqual({ id: 'cand-1', recordsLockedAt: null });
    expect(prisma.execAccessLog.create).toHaveBeenCalledTimes(1);
  });
});
