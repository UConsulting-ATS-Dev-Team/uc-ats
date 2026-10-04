// One person, two accounts: x@ucla.edu and x@g.ucla.edu.
//
// UCLA gives every student both spellings of one inbox (see emailIdentityKey).
// Before Google sign-in learned that, somebody who registered as x@ucla.edu and
// later pressed "Continue with Google" as x@g.ucla.edu was given a second,
// talent-portal account. That account has no UID, so it never sees the
// application or interview scheduling - the candidate lands on a profile page
// with nothing to book.
//
// This file owns the answer to "which account is this person's" across the two
// spellings: sign-in lookups use findAccountForSignIn, and the one-time repair
// (scripts/merge-ucla-twin-accounts.js) folds each existing pair into one.

import prisma from '../prismaClient.js';
import { emailIdentityKey, emailVariants } from '../utils/mailingListImport.js';
import { lockTalentAccount } from './talentAccountLock.js';

const insensitive = (email) => ({ email: { equals: email, mode: 'insensitive' } });

/**
 * User.deactivatedBy on an account a merge retired. Normally an admin's id; this
 * marker is what tells a merge retirement from an admin's deactivation, which
 * must keep the person out. Reactivating clears deactivatedBy, and the marker
 * with it.
 */
export const MERGE_RETIRED_BY = 'ucla-twin-merge';

/** Whether this account was retired by a merge, as opposed to deactivated by an admin. */
export const isMergeRetired = (user) => user?.isActive === false && user.deactivatedBy === MERGE_RETIRED_BY;

/**
 * The account under the other UCLA spelling of this address, or null. Null too
 * when more than one row matches, so a collision is never resolved by sort order.
 */
export const findUclaTwin = async (email, client = prisma) => {
  const twins = emailVariants(email).slice(1);
  if (twins.length === 0) return null;
  const matches = await client.user.findMany({ where: { OR: twins.map(insensitive) }, take: 2 });
  return matches.length === 1 ? matches[0] : null;
};

/**
 * The account a password sign-in or reset for this address belongs to.
 *
 * The address as typed wins while it names an active account. When it names
 * nothing, or only the account a merge retired (the talent half of a merged
 * pair), the active account under the other UCLA spelling answers instead - the
 * same inbox, so the same proof of identity. Otherwise the typed address's own
 * row, so an account an admin deactivated still says it is deactivated.
 */
export const findAccountForSignIn = async (email, client = prisma) => {
  const typed = await client.user.findFirst({ where: insensitive(email) });
  if (typed && typed.isActive !== false) return typed;
  // An admin's deactivation stands: only a merge retirement falls through.
  if (typed && !isMergeRetired(typed)) return typed;

  const twin = await findUclaTwin(email, client);
  if (twin && twin.isActive !== false) return twin;

  return typed;
};

/**
 * What merging one pair would do, decided from the two rows and the resumes on
 * them. Pure, so the dry run and the transaction reach the same answer.
 *
 * The account kept is the one that is not a talent-portal account: it holds
 * the UID (or is staff), which is what every candidate page keys on. The talent
 * account is deactivated, never deleted, so a wrong merge can be undone by hand.
 *
 * Refused, and reported, whenever the pair is not that simple shape - two real
 * accounts, two talent accounts, conflicting UIDs, a deactivated keeper, or a
 * different Google account already on the keeper (moving ours would orphan it;
 * leaving it would strand a Google sign-in on a deactivated account).
 */
export function decideMerge(users, resumes = []) {
  if (users.length !== 2) return { ok: false, reason: `expected 2 accounts, found ${users.length}` };
  // Re-checked rather than trusted from the plan: an address can be edited
  // between the plan and the locked write.
  if (emailIdentityKey(users[0].email) !== emailIdentityKey(users[1].email)) {
    return { ok: false, reason: 'the accounts no longer share a UCLA inbox' };
  }

  const talent = users.filter((u) => u.role === 'USER' && u.isExternalTalent === true);
  if (talent.length !== 1) {
    return { ok: false, reason: talent.length === 0 ? 'neither account is a talent account' : 'both accounts are talent accounts' };
  }
  const retire = talent[0];
  const keep = users.find((u) => u !== retire);

  if (keep.role === 'CLIENT') return { ok: false, reason: 'the other account is a Talent Partner Network client' };
  if (keep.isActive === false) return { ok: false, reason: 'the account to keep is deactivated' };
  if (retire.studentId && keep.studentId && retire.studentId !== keep.studentId) {
    return { ok: false, reason: 'the accounts carry different UIDs' };
  }
  if (retire.googleId && keep.googleId && retire.googleId !== keep.googleId) {
    return { ok: false, reason: 'each account is linked to a different Google account' };
  }

  const moveResumeIds = resumes.filter((r) => r.userId === retire.id).map((r) => r.id);

  // A pair an earlier run already merged: the talent account is deactivated and
  // holds nothing. Reported as done so a re-run after a partial run is a no-op.
  // An admin's deactivation records their id, and a merge must never replace it
  // with the marker, whatever the account still holds: that would hand the
  // retired address a way into the active account the admin did not grant.
  if (retire.isActive === false && retire.deactivatedBy && !isMergeRetired(retire)) {
    return { ok: false, reason: 'the talent account was deactivated by an admin' };
  }
  if (retire.isActive === false && !retire.googleId && moveResumeIds.length === 0) {
    if (isMergeRetired(retire)) return { ok: false, reason: 'already merged' };
    // A merge made before retirements were marked left deactivatedBy empty.
    return { ok: true, keep, retire, moveResumeIds: [], demoteResumeIds: [], moveGoogle: false, fillVerified: null, markOnly: true };
  }

  // Both accounts may each have a current resume. One person has one current
  // resume, so the newest stays current and the rest become history.
  const current = resumes.filter((r) => r.isCurrent).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const demoteResumeIds = current.slice(1).map((r) => r.id);

  return {
    ok: true,
    keep,
    retire,
    moveResumeIds,
    demoteResumeIds,
    moveGoogle: Boolean(retire.googleId && !keep.googleId),
    // Either account proving the inbox proves it for both.
    fillVerified: !keep.emailVerifiedAt && retire.emailVerifiedAt ? retire.emailVerifiedAt : null,
  };
}

/**
 * Every pair of accounts sharing one UCLA inbox, with what merging each would
 * do. Read-only.
 */
export async function planUclaTwinMerges(client = prisma) {
  const users = await client.user.findMany({
    where: { email: { endsWith: 'ucla.edu', mode: 'insensitive' } },
    select: {
      id: true, email: true, fullName: true, role: true, isActive: true, isExternalTalent: true,
      studentId: true, googleId: true, googleLinkedAt: true, emailVerifiedAt: true, deactivatedBy: true,
    },
  });

  const groups = new Map();
  for (const user of users) {
    const key = emailIdentityKey(user.email);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(user);
  }
  const pairs = [...groups.values()].filter((group) => group.length > 1);

  const ids = pairs.flat().map((u) => u.id);
  const resumes = ids.length
    ? await client.externalResume.findMany({
        where: { userId: { in: ids } },
        select: { id: true, userId: true, isCurrent: true, createdAt: true, shareConsent: true },
      })
    : [];

  return pairs.map((group) => {
    const groupIds = new Set(group.map((u) => u.id));
    return { users: group, decision: decideMerge(group, resumes.filter((r) => groupIds.has(r.userId))) };
  });
}

/**
 * Merge one pair, re-deciding from rows read under lock so that nothing that
 * changed since the plan (a resume upload, a Google sign-in) is acted on stale.
 *
 * The talent row is locked first through lockTalentAccount, the lock the
 * resume upload and Google sign-in both take, then the keeper. Google sign-in
 * takes them in that same order, so the two cannot deadlock.
 *
 * Returns the decision acted on, or one with ok: false if the pair no longer
 * qualifies.
 */
export async function mergeUclaTwinPair(keepId, retireId, client = prisma) {
  return client.$transaction(async (tx) => {
    await lockTalentAccount(tx, retireId);
    await tx.$queryRaw`SELECT id FROM users WHERE id = ${keepId} FOR UPDATE`;

    const users = await tx.user.findMany({ where: { id: { in: [keepId, retireId] } } });
    const resumes = await tx.externalResume.findMany({
      where: { userId: { in: [keepId, retireId] } },
      select: { id: true, userId: true, isCurrent: true, createdAt: true },
    });
    const decision = decideMerge(users, resumes);
    if (!decision.ok) return decision;
    if (decision.keep.id !== keepId) return { ok: false, reason: 'the account to keep changed since the plan' };

    // Demote before moving: external_resumes_userId_current_key allows one
    // current resume per user, so moving first would briefly give the keeper two.
    if (decision.demoteResumeIds.length) {
      await tx.externalResume.updateMany({ where: { id: { in: decision.demoteResumeIds } }, data: { isCurrent: false } });
    }
    if (decision.moveResumeIds.length) {
      await tx.externalResume.updateMany({ where: { id: { in: decision.moveResumeIds } }, data: { userId: keepId } });
    }

    // googleId is unique, so it leaves the talent account before it arrives.
    await tx.user.update({
      where: { id: retireId },
      data: {
        isActive: false,
        deactivatedBy: MERGE_RETIRED_BY,
        ...(decision.markOnly ? {} : { deactivatedAt: new Date() }),
        ...(decision.moveGoogle ? { googleId: null, googleLinkedAt: null } : {}),
      },
    });

    const keepData = {};
    if (decision.moveGoogle) {
      keepData.googleId = decision.retire.googleId;
      keepData.googleLinkedAt = decision.retire.googleLinkedAt ?? new Date();
    }
    if (decision.fillVerified) {
      keepData.emailVerifiedAt = decision.fillVerified;
      // Same reason as linkExisting in googleAuth.js: a verification token that
      // outlives the thing it verifies is an account takeover primitive.
      keepData.emailVerificationToken = null;
      keepData.emailVerificationExpiry = null;
    }
    if (Object.keys(keepData).length) await tx.user.update({ where: { id: keepId }, data: keepData });

    return decision;
  });
}
