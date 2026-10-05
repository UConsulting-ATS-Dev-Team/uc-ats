import crypto from 'node:crypto';
import prisma from '../prismaClient.js';
import { invalidateUserCache } from '../middleware/auth.js';
import { emailVariants, emailIdentityKey } from '../utils/mailingListImport.js';
import { lockTalentAccount } from './talentAccountLock.js';

/**
 * Turning a talent-portal account into the applicant account it belongs to.
 *
 * An applicant's account is the one holding their UID (`User.studentId`); the
 * candidate pages, interview sign-up included, find their application through
 * it. A talent-portal account holds no UID, and ProtectedRoute sends it to
 * /talent/profile from every page. So an applicant who ends up with a talent
 * account - Google sign-in under an address the ATS did not know yet, or the
 * talent signup form - cannot reach their own interview sign-up.
 *
 * Talent accounts never ask for a UID, so the link runs through the address:
 * an address the account has verified, matched to the application filed under
 * it, which carries the UID. Google sign-in, password sign-in, email
 * verification and scripts/link-talent-accounts.js all decide it here.
 */

/**
 * Why an address does or does not lead to a UID. `studentId` is set only when
 * the UID can be handed over.
 *
 * A matching address alone proves nothing about the UID: form sync files an
 * application under whatever UID the form names, so someone can type another
 * person's UID with their own address. The UID is only handed over when the
 * candidate's address and every application filed under it are this address
 * (either UCLA spelling), so an application someone else filed under the UID
 * blocks it.
 */
export const APPLICANT_REASONS = {
  NO_APPLICANT: 'no applicant under this address',
  AMBIGUOUS: 'more than one applicant under this address',
  NO_APPLICATION: 'the applicant has no application',
  ADDRESS_MISMATCH: 'an application under this UID was filed from another address',
  UID_HELD: 'another account already holds this UID',
};

export const resolveApplicantForEmail = async (email, db = prisma) => {
  const spellings = emailVariants(email || '').map((variant) => ({ equals: variant, mode: 'insensitive' }));
  if (spellings.length === 0) return { reason: 'NO_APPLICANT' };

  const candidates = await db.candidate.findMany({
    where: { OR: spellings.map((spelling) => ({ email: spelling })) },
    select: { studentId: true, email: true, applications: { select: { email: true } } },
    take: 2
  });
  if (candidates.length === 0 || !candidates[0].studentId) return { reason: 'NO_APPLICANT' };
  if (candidates.length > 1) return { reason: 'AMBIGUOUS' };

  const [candidate] = candidates;
  if (candidate.applications.length === 0) return { reason: 'NO_APPLICATION', uid: candidate.studentId };

  const key = emailIdentityKey(email);
  const addresses = [candidate.email, ...candidate.applications.map((application) => application.email)];
  if (addresses.some((address) => emailIdentityKey(address || '') !== key)) {
    return { reason: 'ADDRESS_MISMATCH', uid: candidate.studentId };
  }

  const holder = await db.user.findUnique({
    where: { studentId: candidate.studentId },
    select: { id: true, email: true }
  });
  if (holder) return { reason: 'UID_HELD', uid: candidate.studentId, holder };

  return { studentId: candidate.studentId };
};

/** The UID this verified address may take, or null. */
export const findApplicantStudentId = async (email) =>
  (await resolveApplicantForEmail(email)).studentId || null;

/**
 * Inside a hand-over transaction: lock the talent account's row and confirm it
 * is still an empty talent account. The talent resume upload takes the same
 * lock, so a resume cannot land between this check and the hand-over and be
 * stranded on an account that no longer reaches the talent portal.
 */
export const lockEmptyTalentAccount = async (tx, userId) => {
  const row = await lockTalentAccount(tx, userId);
  if (!row || row.isExternalTalent !== true || row.studentId) return false;
  return (await tx.externalResume.count({ where: { userId } })) === 0;
};

/**
 * Inside a hand-over transaction: whether every address under this UID - the
 * candidate's and each application's - is one inbox, `addressKey` (an
 * emailIdentityKey), or the candidate's own when `addressKey` is 'candidate'.
 *
 * Read under FOR UPDATE on the candidate row. Filing an application needs a key
 * share on that row for its foreign key, so form sync cannot add one from
 * another address between this check and the hand-over.
 */
const addressesStillMatch = async (tx, studentId, addressKey) => {
  const [candidate] = await tx.$queryRaw`
    SELECT id, email FROM candidates WHERE "studentId" = ${studentId} FOR UPDATE`;
  if (!candidate) return false;
  const applications = await tx.application.findMany({
    where: { candidateId: candidate.id },
    select: { email: true }
  });
  if (applications.length === 0) return false;
  const key = addressKey === 'candidate' ? emailIdentityKey(candidate.email) : addressKey;
  return [candidate.email, ...applications.map((application) => application.email)]
    .every((address) => emailIdentityKey(address || '') === key);
};

/**
 * Hand `studentId` to talent account `userId`, under its row lock. Returns the
 * updated user, or null when it is no longer an empty talent account, the UID
 * was taken in between, or the addresses under it no longer match - the
 * account is then left as it was.
 *
 * `addressKey` is the proof being relied on: the inbox (an emailIdentityKey)
 * this person showed they read, or 'candidate' for the address a code was sent
 * to. It is re-checked under lock against everything filed under the UID, so an
 * application filed from another address meanwhile stops the hand-over. Only
 * an admin linking by hand (scripts/link-talent-accounts.js --link) omits it.
 * `extra` is written in the same update.
 */
export const linkTalentAccountToUid = async (userId, studentId, { addressKey, extra = {} } = {}, db = prisma) => {
  try {
    const updated = await db.$transaction(async (tx) => {
      if (!(await lockEmptyTalentAccount(tx, userId))) return null;
      if (addressKey !== undefined && !(await addressesStillMatch(tx, studentId, addressKey))) return null;
      return tx.user.update({
        where: { id: userId },
        data: { ...extra, isExternalTalent: false, studentId, claimedStudentId: null }
      });
    });
    if (updated) invalidateUserCache(updated.id);
    return updated;
  } catch (error) {
    if (error?.code === 'P2002') return null;
    throw error;
  }
};

/**
 * A talent account that can be linked on its own say-so: a USER with no UID,
 * active, whose stored address it has verified. Changing the stored address
 * clears emailVerifiedAt (PATCH /api/users/:id), so this always speaks for the
 * address stored now.
 */
export const isLinkableTalentAccount = (user) =>
  user?.isExternalTalent === true &&
  !user.studentId &&
  user.role === 'USER' &&
  user.isActive !== false &&
  Boolean(user.emailVerifiedAt);

/**
 * The account this person should be signed in as: their applicant account if
 * this verified talent account turns out to be one, otherwise `user` unchanged.
 * Never throws: a sign-in must not fail because the link could not be made, and
 * the next sign-in tries again.
 */
export const adoptApplicantAccount = async (user) => {
  if (!isLinkableTalentAccount(user)) return user;

  try {
    const { studentId } = await resolveApplicantForEmail(user.email);
    if (!studentId) return user;
    const addressKey = emailIdentityKey(user.email);
    return (await linkTalentAccountToUid(user.id, studentId, { addressKey })) || user;
  } catch (error) {
    console.error('[applicantAccounts] could not link a talent account to its application:', error);
    return user;
  }
};

// ---------------------------------------------------------------------------
// A UID typed into the talent profile
// ---------------------------------------------------------------------------
//
// The typed UID is stored as claimedStudentId and never as studentId until it
// is proved, because studentId is what the candidate pages trust. Proof is a
// code sent to the address the applicant applied from: someone who types
// another person's UID cannot read that person's inbox.
//
// Every answer here says something about the UID typed (nobody applied, an
// account holds it, a code went out), so each account gets one try a minute,
// whatever the answer, and no answer names an address.

export const UID_CODE_TTL_MS = 15 * 60 * 1000;
export const UID_CODE_MAX_ATTEMPTS = 5;
// uidCodeExpiresAt minus the TTL is when the account last typed a UID, as with
// /resend-verification. Set on every try, with or without a code.
export const UID_TRY_INTERVAL_MS = 60 * 1000;
const CODE_LENGTH = 8;

/** Nine digits with anything else stripped, as form sync and Luma read a UID. */
export const normalizeUid = (raw) => {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return /^\d{9}$/.test(digits) ? digits : null;
};

const hashCode = (userId, code) =>
  crypto.createHash('sha256').update(`${userId}:${code}`).digest('hex');

const CLEARED_CODE = { uidCodeHash: null, uidCodeExpiresAt: null, uidCodeAttempts: 0 };

/**
 * Take this minute's try, or report TOO_SOON. One conditional write, so two
 * requests at once cannot both pass; it also retires any code still pending.
 */
const takeTry = async (db, userId) => {
  const now = Date.now();
  const { count } = await db.user.updateMany({
    where: {
      id: userId,
      OR: [
        { uidCodeExpiresAt: null },
        { uidCodeExpiresAt: { lte: new Date(now + UID_CODE_TTL_MS - UID_TRY_INTERVAL_MS) } }
      ]
    },
    data: { uidCodeHash: null, uidCodeAttempts: 0, uidCodeExpiresAt: new Date(now + UID_CODE_TTL_MS) }
  });
  return count === 1;
};

/**
 * A talent account typed `rawUid` into its profile. Answers what happened:
 *
 *   INVALID     not nine digits (does not use up the minute's try)
 *   TOO_SOON    a UID was tried less than a minute ago
 *   TAKEN       another account holds the UID
 *   LINKED      this account's own verified address already proves it: linked
 *   CODE_SENT   a code went to the address on the application
 *   SAVED       nobody has applied under it yet; kept until someone does
 *   NEEDS_ADMIN the applications under it were filed from different addresses,
 *               or this account holds a talent-portal resume
 *   SEND_FAILED the code could not be sent
 *
 * `sendCode({ to, name, code })` delivers the code; injected so this module
 * does not import the mailer.
 */
export const claimUid = async (user, rawUid, { sendCode }, db = prisma) => {
  const uid = normalizeUid(rawUid);
  if (!uid) return { status: 'INVALID' };
  if (!(await takeTry(db, user.id))) return { status: 'TOO_SOON' };

  const holder = await db.user.findUnique({ where: { studentId: uid }, select: { id: true } });
  if (holder && holder.id !== user.id) return { status: 'TAKEN' };

  const candidate = await db.candidate.findUnique({
    where: { studentId: uid },
    select: { email: true, firstName: true, applications: { select: { email: true } } }
  });

  if (!candidate || candidate.applications.length === 0) {
    await db.user.update({ where: { id: user.id }, data: { claimedStudentId: uid } });
    return { status: 'SAVED' };
  }

  // The address on file must be one inbox. Applications under this UID from
  // different addresses mean someone else may have filed under it, and a code
  // to either address would let that person in.
  const key = emailIdentityKey(candidate.email);
  if (candidate.applications.some((application) => emailIdentityKey(application.email || '') !== key)) {
    return { status: 'NEEDS_ADMIN' };
  }

  if ((await db.externalResume.count({ where: { userId: user.id } })) > 0) {
    return { status: 'NEEDS_ADMIN' };
  }

  // Already proved: the account verified the very address the applicant used.
  if (isLinkableTalentAccount(user) && emailIdentityKey(user.email) === key) {
    const linked = await linkTalentAccountToUid(user.id, uid, { addressKey: key, extra: CLEARED_CODE }, db);
    if (linked) return { status: 'LINKED', user: linked };
  }

  // Eight digits, not six: a code can be re-requested every minute with five
  // guesses each, and at six digits that is better than 1 in 200 a day.
  const code = String(crypto.randomInt(0, 100_000_000)).padStart(CODE_LENGTH, '0');
  await db.user.update({
    where: { id: user.id },
    data: { claimedStudentId: uid, uidCodeHash: hashCode(user.id, code), uidCodeAttempts: 0 }
  });

  const sent = await sendCode({ to: candidate.email, name: candidate.firstName, code });
  if (sent?.success === false) {
    // Nothing went out, so do not hold the next try back a minute.
    await db.user.update({ where: { id: user.id }, data: CLEARED_CODE });
    return { status: 'SEND_FAILED' };
  }
  return { status: 'CODE_SENT' };
};

/**
 * The code from claimUid's email. Answers LINKED (with the updated user),
 * WRONG (with attempts left), EXPIRED (no live code; ask for a new one),
 * TAKEN, or NEEDS_ADMIN when the account gained a talent-portal resume or an
 * application under the UID came from another address after the code was sent.
 */
export const confirmUidCode = async (userId, rawCode, db = prisma) => {
  const code = String(rawCode ?? '').replace(/\D/g, '');
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { claimedStudentId: true, uidCodeHash: true, uidCodeExpiresAt: true, uidCodeAttempts: true }
  });

  if (!row?.uidCodeHash || !row.claimedStudentId || !row.uidCodeExpiresAt || row.uidCodeExpiresAt < new Date()) {
    return { status: 'EXPIRED' };
  }

  // Spend an attempt before looking at the guess. Conditional on the count
  // still being under the limit, so guesses arriving together cannot each read
  // the same count and get more than five between them.
  const { count } = await db.user.updateMany({
    where: { id: userId, uidCodeHash: row.uidCodeHash, uidCodeAttempts: { lt: UID_CODE_MAX_ATTEMPTS } },
    data: { uidCodeAttempts: { increment: 1 } }
  });
  if (count === 0) return { status: 'EXPIRED' };

  const expected = Buffer.from(row.uidCodeHash, 'hex');
  const given = Buffer.from(hashCode(userId, code), 'hex');
  if (code.length !== CODE_LENGTH || !crypto.timingSafeEqual(expected, given)) {
    return { status: 'WRONG', attemptsLeft: Math.max(0, UID_CODE_MAX_ATTEMPTS - row.uidCodeAttempts - 1) };
  }

  const linked = await linkTalentAccountToUid(
    userId, row.claimedStudentId, { addressKey: 'candidate', extra: CLEARED_CODE }, db
  );
  if (linked) return { status: 'LINKED', user: linked };

  const holder = await db.user.findUnique({ where: { studentId: row.claimedStudentId }, select: { id: true } });
  return holder && holder.id !== userId ? { status: 'TAKEN' } : { status: 'NEEDS_ADMIN' };
};

/** Lowercased first and last word of a name, for the sweep's name-only hint. */
const nameKey = (first, last) => {
  const clean = (value) => (value || '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  return `${clean(first)}|${clean(last)}`;
};

const splitFullName = (fullName) => {
  const words = (fullName || '').trim().split(/\s+/).filter(Boolean);
  return words.length < 2 ? null : nameKey(words[0], words[words.length - 1]);
};

/**
 * Every talent account without a UID, and what to do with it.
 *
 * `decision.link` is a UID the account may take now. Otherwise `decision.reason`
 * says why not, and `nameMatches` lists applicants whose name matches the
 * account's - the person who applied under a UCLA address and signed up with a
 * personal one. A name is not proof, so those are only reported, for an admin
 * to confirm and link with --link.
 */
export const planTalentAccountLinks = async (db = prisma) => {
  const accounts = await db.user.findMany({
    where: { role: 'USER', isExternalTalent: true, studentId: null, isActive: true },
    select: { id: true, email: true, fullName: true, role: true, isExternalTalent: true, studentId: true, isActive: true, emailVerifiedAt: true, claimedStudentId: true, createdAt: true, _count: { select: { externalResumes: true } } },
    orderBy: { createdAt: 'asc' }
  });

  // Read once for the name hint; a cycle's applicants number in the hundreds.
  const candidates = await db.candidate.findMany({
    select: { studentId: true, firstName: true, lastName: true, email: true }
  });
  const byName = new Map();
  for (const candidate of candidates) {
    const key = nameKey(candidate.firstName, candidate.lastName);
    byName.set(key, [...(byName.get(key) || []), candidate]);
  }

  const plan = [];
  for (const account of accounts) {
    const key = splitFullName(account.fullName);
    const nameMatches = (key && byName.get(key)) || [];

    let decision;
    if (!account.emailVerifiedAt) {
      decision = { reason: 'UNVERIFIED' };
    } else {
      const resolved = await resolveApplicantForEmail(account.email, db);
      if (resolved.studentId && account._count.externalResumes > 0) {
        decision = { reason: 'HAS_TALENT_RESUME', uid: resolved.studentId };
      } else {
        decision = resolved.studentId ? { link: resolved.studentId } : resolved;
      }
    }

    plan.push({ account, decision, nameMatches });
  }
  return plan;
};

export const PLAN_REASONS = {
  ...APPLICANT_REASONS,
  UNVERIFIED: 'the account never verified its address',
  HAS_TALENT_RESUME: 'the account holds a talent-portal resume',
};
