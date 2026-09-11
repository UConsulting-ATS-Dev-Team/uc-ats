import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import config from '../config.js';

// Executive-committee access to sealed recruiting records.
//
// A person's scores, evaluations, comments and application are sealed once they
// become a member (Candidate.recordsLockedAt). Members can later be promoted to
// admin and sit on recruitment, where they would otherwise read their own file
// and their classmates'. Reading a sealed record therefore takes a second
// secret, held by the executive committee, on top of a normal login.
//
// Entering it buys a short-lived unlock token that the client sends back in the
// X-Exec-Unlock header. The token is signed with a key derived from JWT_SECRET
// rather than JWT_SECRET itself, so an unlock token can never be replayed as a
// login token and a login token can never pass as an unlock.

export const EXEC_UNLOCK_HEADER = 'x-exec-unlock';
export const UNLOCK_TTL_SECONDS = 30 * 60;
export const MIN_EXEC_PASSWORD_LENGTH = 12;
export const MAX_FAILED_ATTEMPTS = 5;
export const FAILED_ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

const SETTING_ID = 'singleton';
const TOKEN_PURPOSE = 'exec-unlock';

export const EXEC_ACCESS_ACTIONS = Object.freeze({
  UNLOCK_OK: 'UNLOCK_OK',
  UNLOCK_FAILED: 'UNLOCK_FAILED',
  UNLOCK_RATE_LIMITED: 'UNLOCK_RATE_LIMITED',
  LOCK_RECORD: 'LOCK_RECORD',
  UNLOCK_RECORD: 'UNLOCK_RECORD',
  AUTO_LOCK: 'AUTO_LOCK',
  BACKFILL_LOCK: 'BACKFILL_LOCK',
  PASSWORD_SET: 'PASSWORD_SET'
});

const unlockKey = () => crypto.createHmac('sha256', config.jwtSecret).update(TOKEN_PURPOSE).digest();

export function issueUnlockToken(userId) {
  const token = jwt.sign({ purpose: TOKEN_PURPOSE }, unlockKey(), {
    subject: userId,
    expiresIn: UNLOCK_TTL_SECONDS,
    algorithm: 'HS256'
  });
  const { exp } = jwt.decode(token);
  return { token, expiresAt: new Date(exp * 1000).toISOString() };
}

/**
 * The unlock this request carries for its own authenticated user, as
 * `{ expiresAt }`, or null. A token issued to someone else, expired, or signed
 * for another purpose is null - never an error.
 */
export function readUnlock(req) {
  const token = req.headers?.[EXEC_UNLOCK_HEADER];
  const userId = req.user?.id;
  if (!token || typeof token !== 'string' || !userId) return null;

  try {
    const decoded = jwt.verify(token, unlockKey(), { algorithms: ['HS256'], subject: userId });
    if (decoded.purpose !== TOKEN_PURPOSE) return null;
    return { expiresAt: new Date(decoded.exp * 1000).toISOString() };
  } catch {
    return null;
  }
}

export const isExecUnlocked = (req) => readUnlock(req) !== null;

// userId -> timestamps of recent wrong guesses. In memory, like the auth user
// cache: a restart forgets them, which buys a guesser at most one extra window.
const failedAttempts = new Map();

const recentFailures = (userId, now) =>
  (failedAttempts.get(userId) || []).filter((at) => now - at < FAILED_ATTEMPT_WINDOW_MS);

export function isRateLimited(userId, now = Date.now()) {
  return recentFailures(userId, now).length >= MAX_FAILED_ATTEMPTS;
}

export function recordFailedAttempt(userId, now = Date.now()) {
  const failures = recentFailures(userId, now);
  failures.push(now);
  failedAttempts.set(userId, failures);
}

export function clearFailedAttempts(userId) {
  failedAttempts.delete(userId);
}

export async function isExecPasswordConfigured(client = prisma) {
  const setting = await client.execAccessSetting.findUnique({
    where: { id: SETTING_ID },
    select: { id: true }
  });
  return Boolean(setting);
}

// Fails closed: with no password configured, nothing verifies.
export async function verifyExecPassword(password, client = prisma) {
  if (typeof password !== 'string' || password.length === 0) return false;
  const setting = await client.execAccessSetting.findUnique({ where: { id: SETTING_ID } });
  if (!setting) return false;
  return bcrypt.compare(password, setting.passwordHash);
}

export function validateNewExecPassword(password) {
  if (typeof password !== 'string' || password.length < MIN_EXEC_PASSWORD_LENGTH) {
    return `The executive password must be at least ${MIN_EXEC_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

export function logExecAccess({ userId = null, action, candidateId = null, ipAddress = null }, client = prisma) {
  return client.execAccessLog.create({ data: { userId, action, candidateId, ipAddress } });
}

export async function setExecPassword(password, { updatedById = null } = {}, client = prisma) {
  const problem = validateNewExecPassword(password);
  if (problem) {
    const error = new Error(problem);
    error.status = 400;
    throw error;
  }

  const passwordHash = await bcrypt.hash(password, 12);
  await client.execAccessSetting.upsert({
    where: { id: SETTING_ID },
    create: { id: SETTING_ID, passwordHash, updatedById },
    update: { passwordHash, updatedById }
  });
  await logExecAccess({ userId: updatedById, action: EXEC_ACCESS_ACTIONS.PASSWORD_SET }, client);
}

/**
 * Seal a candidate's records. Returns true when this call sealed them, false
 * when they were already sealed (or the candidate does not exist), so repeat
 * calls neither move recordsLockedAt nor write a second audit row.
 */
export async function lockCandidateRecords(
  candidateId,
  { userId = null, action = EXEC_ACCESS_ACTIONS.LOCK_RECORD, ipAddress = null } = {},
  client = prisma
) {
  const { count } = await client.candidate.updateMany({
    where: { id: candidateId, recordsLockedAt: null },
    data: { recordsLockedAt: new Date(), recordsLockedById: userId }
  });
  if (count > 0) {
    await logExecAccess({ userId, action, candidateId, ipAddress }, client);
  }
  return count > 0;
}

export async function unlockCandidateRecords(candidateId, { userId = null, ipAddress = null } = {}, client = prisma) {
  const { count } = await client.candidate.updateMany({
    where: { id: candidateId, recordsLockedAt: { not: null } },
    data: { recordsLockedAt: null, recordsLockedById: null }
  });
  if (count > 0) {
    await logExecAccess({ userId, action: EXEC_ACCESS_ACTIONS.UNLOCK_RECORD, candidateId, ipAddress }, client);
  }
  return count > 0;
}
