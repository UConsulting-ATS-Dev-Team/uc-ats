import prisma from '../prismaClient.js';
import { isExecUnlocked } from '../services/execAccess.js';
import { isOwnedBy } from './applicationOwnership.js';
import { emailIdentityKey, emailVariants } from './mailingListImport.js';

// Server-side enforcement of sealed recruiting records (Candidate.recordsLockedAt).
//
// Routes hand out evaluation data in two shapes, and the seal follows the shape:
// - a single record (one candidate's scores, one application) answers 423 with
//   code RECORD_LOCKED, which the client turns into an "enter the executive
//   password" placeholder;
// - a list keeps its sealed rows - dropping them would make counts and pages
//   disagree with what admins know exists - but cuts them down to identity with
//   redactApplication and marks them `locked: true`.
//
// A request carrying a valid executive unlock sees everything, and none of these
// helpers touch the database for it. Server-internal reads (offer letters, form
// sync, decision processing) do not pass through here.
//
// The guards add one rule that holds even with an unlock: staff never write to
// their own record. Nobody grades, comments on or decides their own application.

export const RECORD_LOCKED_CODE = 'RECORD_LOCKED';
export const RECORD_LOCKED_MESSAGE = 'This record is sealed. Enter the executive password to view it.';
export const OWN_RECORD_CODE = 'OWN_RECORD';

// What survives redaction: enough to put a name on a row, nothing about how the
// person was evaluated or what they wrote.
const APPLICATION_IDENTITY_KEYS = [
  'id',
  'candidateId',
  'cycleId',
  'cycle',
  'firstName',
  'lastName',
  'name',
  'email',
  'studentId',
  'headshotUrl',
  'status',
  'submittedAt'
];

const CANDIDATE_IDENTITY_KEYS = ['id', 'studentId', 'firstName', 'lastName', 'email', 'createdAt', 'assignedGroupId'];

function redactRow(row, keepKeys) {
  const redacted = {};
  for (const [key, value] of Object.entries(row || {})) {
    if (keepKeys.includes(key)) {
      redacted[key] = value;
    } else if (Array.isArray(value)) {
      // Lists stay, emptied, so a client mapping over row.comments still has an
      // array to map instead of crashing on undefined.
      redacted[key] = [];
    }
  }
  redacted.locked = true;
  return redacted;
}

export const redactApplication = (row) => redactRow(row, APPLICATION_IDENTITY_KEYS);

export function redactCandidate(candidate) {
  const redacted = redactRow(candidate, CANDIDATE_IDENTITY_KEYS);
  if (Array.isArray(candidate?.applications)) {
    redacted.applications = candidate.applications.map(redactApplication);
  }
  return redacted;
}

// How a row names its person. Application-shaped rows carry these directly;
// rows that nest the candidate carry them one level down.
const defaultRefOf = (row) => ({
  candidateId: row?.candidateId ?? row?.candidate?.id ?? null,
  studentId: row?.studentId ?? row?.candidate?.studentId ?? null,
  email: row?.email ?? row?.candidate?.email ?? null
});

const unique = (values) => [...new Set(values.filter(Boolean))];

const NEVER_LOCKED = () => false;

/**
 * One query for a whole list: resolves which of `rows` belong to a sealed
 * candidate and returns a synchronous `(row) => boolean`. A row's candidateId is
 * authoritative; a row without one falls back to studentId and email, the two
 * fields Candidate is unique on.
 */
export async function lockedRowPredicate(req, rows, options) {
  if (isExecUnlocked(req)) return NEVER_LOCKED;
  return sealedRowPredicate(rows, options);
}

/**
 * lockedRowPredicate without the executive unlock: which rows are sealed, full
 * stop. For content that is shown to people other than the requester - a live
 * vote puts a candidate in front of the whole room, and one admin's unlock says
 * nothing about who else is watching.
 */
export async function sealedRowPredicate(rows, { refOf = defaultRefOf, client = prisma } = {}) {
  if (!rows?.length) return NEVER_LOCKED;

  const refs = rows.map(refOf);
  const candidateIds = unique(refs.map((ref) => ref.candidateId));
  const orphans = refs.filter((ref) => !ref.candidateId);
  const studentIds = unique(orphans.map((ref) => ref.studentId));
  // joe@g.ucla.edu and joe@ucla.edu are one inbox (emailIdentityKey), so an
  // orphan row under either spelling is sealed with the candidate.
  const emails = unique(orphans.flatMap((ref) => (ref.email ? [ref.email, ...emailVariants(ref.email)] : [])));

  const anyOf = [];
  if (candidateIds.length) anyOf.push({ id: { in: candidateIds } });
  if (studentIds.length) anyOf.push({ studentId: { in: studentIds } });
  if (emails.length) anyOf.push({ email: { in: emails } });
  if (!anyOf.length) return NEVER_LOCKED;

  const sealed = await client.candidate.findMany({
    where: { recordsLockedAt: { not: null }, OR: anyOf },
    select: { id: true, studentId: true, email: true }
  });
  if (!sealed.length) return NEVER_LOCKED;

  const sealedIds = new Set(sealed.map((candidate) => candidate.id));
  const sealedStudentIds = new Set(sealed.map((candidate) => candidate.studentId));
  const sealedEmails = new Set(sealed.map((candidate) => emailIdentityKey(candidate.email)).filter(Boolean));

  return (row) => {
    const ref = refOf(row);
    if (ref.candidateId) return sealedIds.has(ref.candidateId);
    return Boolean(
      (ref.studentId && sealedStudentIds.has(ref.studentId)) ||
      (ref.email && sealedEmails.has(emailIdentityKey(ref.email)))
    );
  };
}

export async function redactLockedApplications(req, rows, options) {
  const isLocked = await lockedRowPredicate(req, rows, options);
  return rows.map((row) => (isLocked(row) ? redactApplication(row) : row));
}

export async function isCandidateLocked(req, candidateId, client = prisma) {
  if (!candidateId || isExecUnlocked(req)) return false;
  const sealed = await client.candidate.findFirst({
    where: { id: candidateId, recordsLockedAt: { not: null } },
    select: { id: true }
  });
  return Boolean(sealed);
}

export async function isApplicationLocked(req, applicationId, client = prisma) {
  if (!applicationId || isExecUnlocked(req)) return false;
  const application = await client.application.findUnique({
    where: { id: applicationId },
    select: { candidateId: true, studentId: true, email: true }
  });
  if (!application) return false;
  const isLocked = await lockedRowPredicate(req, [application], { client });
  return isLocked(application);
}

/** The subset of `applicationIds` that belong to sealed candidates. */
export async function lockedApplicationIds(req, applicationIds, client = prisma) {
  if (isExecUnlocked(req)) return new Set();
  return sealedApplicationIds(applicationIds, client);
}

/** lockedApplicationIds, ignoring any executive unlock - see sealedRowPredicate. */
export async function sealedApplicationIds(applicationIds, client = prisma) {
  const ids = unique(applicationIds || []);
  if (!ids.length) return new Set();

  const applications = await client.application.findMany({
    where: { id: { in: ids } },
    select: { id: true, candidateId: true, studentId: true, email: true }
  });
  const isSealed = await sealedRowPredicate(applications, { client });
  return new Set(applications.filter(isSealed).map((application) => application.id));
}

export async function isOwnCandidate(user, candidateId, client = prisma) {
  if (!user || !candidateId) return false;
  const candidate = await client.candidate.findUnique({
    where: { id: candidateId },
    select: { email: true, studentId: true }
  });
  return Boolean(candidate) && isOwnedBy(candidate, user);
}

export async function isOwnApplication(user, applicationId, client = prisma) {
  if (!user || !applicationId) return false;
  const application = await client.application.findUnique({
    where: { id: applicationId },
    select: { email: true, studentId: true, candidate: { select: { email: true, studentId: true } } }
  });
  return Boolean(application) && isOwnedBy(application, user);
}

export const sendRecordLocked = (res) =>
  res.status(423).json({ error: RECORD_LOCKED_MESSAGE, code: RECORD_LOCKED_CODE });

const sendOwnRecord = (res) =>
  res.status(403).json({ error: 'You cannot review or change your own application.', code: OWN_RECORD_CODE });

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Resolves to true when it has already answered the request.
async function enforce(req, res, id, { isLocked, isOwn }) {
  if (!READ_METHODS.has(req.method) && (await isOwn(req.user, id))) {
    sendOwnRecord(res);
    return true;
  }
  if (await isLocked(req, id)) {
    sendRecordLocked(res);
    return true;
  }
  return false;
}

const failClosed = (res, error) => {
  // A seal that cannot be checked is treated as held.
  console.error('[record lock guard]', error);
  res.status(500).json({ error: 'Failed to check record access' });
};

const CANDIDATE_CHECKS = { isLocked: isCandidateLocked, isOwn: isOwnCandidate };
const APPLICATION_CHECKS = { isLocked: isApplicationLocked, isOwn: isOwnApplication };

const middlewareFor = (checks) => (pickId) => async (req, res, next) => {
  try {
    if (await enforce(req, res, pickId(req), checks)) return;
    next();
  } catch (error) {
    failClosed(res, error);
  }
};

const paramHandlerFor = (checks) => async (req, res, next, id) => {
  try {
    if (await enforce(req, res, id, checks)) return;
    next();
  } catch (error) {
    failClosed(res, error);
  }
};

/** Route middleware for the candidate `pickId(req)` names. */
export const guardCandidate = middlewareFor(CANDIDATE_CHECKS);

/** Route middleware for the application `pickId(req)` names. */
export const guardApplication = middlewareFor(APPLICATION_CHECKS);

/** For `router.param(name, ...)` where every route's param is a candidate id. */
export const candidateParamGuard = paramHandlerFor(CANDIDATE_CHECKS);

/** For `router.param(name, ...)` where every route's param is an application id. */
export const applicationParamGuard = paramHandlerFor(APPLICATION_CHECKS);
