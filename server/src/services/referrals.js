import prisma from '../prismaClient.js';

// Pre-application referrals: a member vouches for someone who has not applied
// yet, so there is no Candidate row to hang the referral on. All the member is
// expected to know is a first and last name, which makes the name the join key
// until form sync produces a real Candidate.
//
// Name matching is deliberately forgiving about the things people vary on
// (case, accents, punctuation, double spaces) and strict about everything else.
// We would rather leave a referral unclaimed than staple it to the wrong person:
// an unclaimed referral is visible and fixable, a misattached one is a quiet
// lie on somebody's profile.

// Everything that is not a letter or digit is dropped outright rather than
// turned into a space, so "O'Brien", "OBrien" and "o brien" all land on the
// same key - as do "Smith-Jones" and "Smith Jones", and "Ann Marie" and
// "Annmarie". Spacing and punctuation inside a name are exactly what two people
// typing the same name disagree about.
const normalizePart = (value) =>
  String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // José and Jose are the same person
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');

/**
 * The stored match key for a referred person, or null when either half of the
 * name is missing. Both writes and lookups go through this, so the two can
 * never disagree about what counts as the same name.
 */
export function referralNameKey(firstName, lastName) {
  const first = normalizePart(firstName);
  const last = normalizePart(lastName);
  if (!first || !last) return null;
  return `${first}|${last}`;
}

/** How a referral names the person it is about, claimed or not. */
export function referredDisplayName(referral) {
  if (referral?.candidate) {
    const { firstName, lastName } = referral.candidate;
    const joined = [firstName, lastName].filter(Boolean).join(' ').trim();
    if (joined) return joined;
  }
  const joined = [referral?.referredFirstName, referral?.referredLastName].filter(Boolean).join(' ').trim();
  return joined || 'Unknown';
}

/**
 * Attaches any unclaimed referrals for this name to the candidate. Called from
 * form sync once an application has resolved to a Candidate, which is the
 * moment a referred person stops being just a name.
 *
 * A referral is claimed only within its own cycle (or when it was filed without
 * one). A referral written for last year's recruiting cycle is not evidence
 * about this year's applicant, even when the name matches.
 *
 * Returns the ids it claimed, so callers can log what moved.
 */
export async function claimReferralsForCandidate({ candidate, cycleId, client = prisma }) {
  const nameKey = referralNameKey(candidate?.firstName, candidate?.lastName);
  if (!nameKey || !candidate?.id) return [];

  const pending = await client.referral.findMany({
    where: {
      candidateId: null,
      referredNameKey: nameKey,
      ...(cycleId ? { OR: [{ cycleId }, { cycleId: null }] } : {})
    },
    select: { id: true }
  });

  if (!pending.length) return [];

  const ids = pending.map((referral) => referral.id);
  await client.referral.updateMany({
    where: { id: { in: ids } },
    data: {
      candidateId: candidate.id,
      claimedAt: new Date(),
      ...(cycleId ? { cycleId } : {})
    }
  });

  return ids;
}

/**
 * Records a pre-application referral. Returns `{ referral }`, or
 * `{ duplicate: true }` when this member has already referred this person in
 * this cycle - a second submission is a double-click or a forgotten one, not a
 * second endorsement. Two *different* members referring the same person are
 * both kept: that is real signal, not a duplicate.
 *
 * If the person already exists as a Candidate, the referral attaches
 * immediately instead of waiting for a sync that would never mention them.
 */
export async function createPreApplicationReferral(
  { referrerName, relationship, referredFirstName, referredLastName, cycleId, referredByUserId },
  client = prisma
) {
  const nameKey = referralNameKey(referredFirstName, referredLastName);
  if (!nameKey) {
    throw new Error('referralNameKey requires both a first and a last name');
  }

  const existing = await client.referral.findFirst({
    where: { referredNameKey: nameKey, cycleId: cycleId ?? null, referredByUserId },
    select: { id: true }
  });
  if (existing) return { duplicate: true, referral: null };

  const candidate = await client.candidate.findFirst({
    where: candidateNameMatch(referredFirstName, referredLastName),
    select: { id: true }
  });

  const referral = await client.referral.create({
    data: {
      referrerName,
      relationship,
      source: 'PRE_APPLICATION',
      referredFirstName: String(referredFirstName).trim(),
      referredLastName: String(referredLastName).trim(),
      referredNameKey: nameKey,
      referredByUserId,
      cycleId: cycleId ?? null,
      candidateId: candidate?.id ?? null,
      claimedAt: candidate ? new Date() : null
    },
    include: { candidate: { select: { id: true, firstName: true, lastName: true } } }
  });

  return { duplicate: false, referral };
}

/**
 * Case-insensitive exact match on both names. Used only to short-circuit the
 * wait when the referred person is already in the system; the authoritative
 * match on sync is the stored key.
 */
function candidateNameMatch(firstName, lastName) {
  return {
    firstName: { equals: String(firstName).trim(), mode: 'insensitive' },
    lastName: { equals: String(lastName).trim(), mode: 'insensitive' }
  };
}
