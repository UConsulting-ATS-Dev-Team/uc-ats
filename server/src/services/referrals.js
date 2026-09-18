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
//
// \p{L} and \p{N} keep letters and digits in every script, not just ASCII. A
// name written in Cyrillic, Arabic or CJK has to survive this: stripping to
// a-z would normalize it to nothing, and a person whose name normalizes to
// nothing cannot be referred at all.
const normalizePart = (value) =>
  String(value ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // José and Jose are the same person
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

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

  const run = async (tx) => {
    // Everything that decides a name is unambiguous, and everything that acts
    // on that decision, happens under one lock keyed on the name. Sync runs
    // every five minutes and a slow run can overlap the next: without this,
    // two applicants called John Smith can each be checked before the other's
    // application is committed, and both pass a check that should have failed
    // for both.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${nameKey}))`;

    // Two applicants in one cycle can share a name, and a name is the only
    // thing an "Other" referral has to go on. When that happens there is no way
    // to tell which of them the member meant, so nothing is claimed: the
    // referral stays pending and visible in the admin queue. A referral sitting
    // unclaimed is a question someone can answer. A referral silently stapled
    // to the wrong applicant is a false endorsement nobody will ever notice.
    const sharingName = await candidateIdsMatchingName({ nameKey, cycleId, client: tx });
    if (sharingName.filter((id) => id !== candidate.id).length > 0) {
      console.warn(
        `Not claiming referrals for candidate id=${candidate.id}: ${sharingName.length} candidates in cycle ${cycleId} share that name`
      );
      return [];
    }

    const pending = await tx.referral.findMany({
      where: {
        candidateId: null,
        referredNameKey: nameKey,
        ...(cycleId ? { OR: [{ cycleId }, { cycleId: null }] } : {})
      },
      select: { id: true }
    });

    if (!pending.length) return [];

    const ids = pending.map((referral) => referral.id);
    // `candidateId: null` again, not just the ids: an admin may have placed one
    // of these by hand since the read above. Their answer outranks this one,
    // and sync must not quietly move an endorsement they already settled.
    const { count } = await tx.referral.updateMany({
      where: { id: { in: ids }, candidateId: null },
      data: {
        candidateId: candidate.id,
        claimedAt: new Date(),
        ...(cycleId ? { cycleId } : {})
      }
    });

    if (count === 0) return [];
    // `count` can be short of `ids.length` when an admin placed one of these in
    // between, and it does not say which ones moved. Read back the referrals
    // that actually point at this candidate, so the caller's log names what
    // really happened rather than what was attempted.
    const claimed = await tx.referral.findMany({
      where: { id: { in: ids }, candidateId: candidate.id },
      select: { id: true }
    });
    return claimed.map((referral) => referral.id);
  };

  return typeof client.$transaction === 'function' ? client.$transaction(run) : run(client);
}

const referralInclude = { candidate: { select: { id: true, firstName: true, lastName: true } } };

/**
 * Records a member's referral. Two ways in:
 *
 * - `candidateId` - the member picked a real person out of the search box.
 *   There is nothing to guess about, so the referral attaches on the spot.
 * - `referredFirstName` / `referredLastName` - the member chose "Other"
 *   because the person is not in the system yet. The referral waits, and form
 *   sync claims it when an application shows up under that name.
 *
 * Returns `{ referral }`, or `{ duplicate: true }` when this member has already
 * referred this person in this cycle - a second submission is a double-click or
 * a forgotten one, not a second endorsement. Two *different* members referring
 * the same person are both kept: that is real signal, not a duplicate.
 */
export async function createMemberReferral(
  { referrerName, relationship, referredFirstName, referredLastName, candidateId, cycleId, referredByUserId },
  client = prisma
) {
  // Scoped to the cycle, exactly like the typeahead that produced this id. The
  // id arrives in a request body, so nothing stops a member from sending one
  // the search box would never have offered them - a candidate from another
  // cycle, attached to a referral labelled with this one.
  const chosen = candidateId
    ? await client.candidate.findFirst({
        where: {
          id: candidateId,
          ...(cycleId ? { applications: { some: { cycleId } } } : {})
        },
        select: { id: true, firstName: true, lastName: true, recordsLockedAt: true }
      })
    : null;

  if (candidateId && !chosen) return { notFound: true, referral: null };
  // A sealed record belongs to someone who is already a member. Referring them
  // into the cycle they were recruited in is meaningless.
  if (chosen?.recordsLockedAt) return { sealed: true, referral: null };

  // The stored name is whoever the referral is actually about: the candidate
  // they picked, or what they typed under "Other".
  const firstName = chosen ? chosen.firstName : referredFirstName;
  const lastName = chosen ? chosen.lastName : referredLastName;

  const nameKey = referralNameKey(firstName, lastName);
  if (!nameKey) {
    throw new Error('referralNameKey requires both a first and a last name');
  }

  const existing = await client.referral.findFirst({
    where: { referredNameKey: nameKey, cycleId: cycleId ?? null, referredByUserId },
    select: { id: true }
  });
  if (existing) return { duplicate: true, referral: null };

  // "Other" never attaches on submit, even when a name happens to match
  // someone already in the system. The member just told us this person was not
  // in the list, so a match here is either someone they scrolled past or a
  // different person with the same name, and we cannot tell which. Form sync
  // claims it if they turn out to be a genuinely new applicant; otherwise an
  // admin places it. Guessing at this point attaches to whoever applied first,
  // which is not an answer, just an early one.
  const resolvedCandidateId = chosen?.id ?? null;

  try {
    const referral = await client.referral.create({
      data: {
        referrerName,
        relationship,
        source: 'PRE_APPLICATION',
        referredFirstName: String(firstName).trim(),
        referredLastName: String(lastName).trim(),
        referredNameKey: nameKey,
        referredByUserId,
        cycleId: cycleId ?? null,
        candidateId: resolvedCandidateId,
        claimedAt: resolvedCandidateId ? new Date() : null
      },
      include: referralInclude
    });

    return { duplicate: false, referral };
  } catch (error) {
    // The findFirst above cannot stop two concurrent submissions from both
    // passing it. The unique index on (referredByUserId, cycleId,
    // referredNameKey) is what actually holds, and losing that race means the
    // same thing as losing the check: this member already referred them.
    if (error?.code === 'P2002') return { duplicate: true, referral: null };
    throw error;
  }
}

/**
 * An admin resolving a referral that never found its person: the name was
 * spelled differently, two applicants share it, or the member picked "Other"
 * for someone who was already in the system. Attaching by hand is the escape
 * hatch for every case name matching cannot decide on its own.
 */
export async function attachReferralToCandidate({ referralId, candidateId, client = prisma }) {
  const [referral, candidate] = await Promise.all([
    client.referral.findUnique({ where: { id: referralId }, select: { id: true, candidateId: true } }),
    client.candidate.findUnique({
      where: { id: candidateId },
      select: { id: true, recordsLockedAt: true }
    })
  ]);

  if (!referral) return { notFound: 'referral', referral: null };
  if (!candidate) return { notFound: 'candidate', referral: null };
  if (candidate.recordsLockedAt) return { sealed: true, referral: null };

  const updated = await client.referral.update({
    where: { id: referralId },
    data: { candidateId, claimedAt: new Date() },
    include: referralInclude
  });

  return { referral: updated };
}

/**
 * Candidate ids in this cycle whose name normalizes to `nameKey`.
 *
 * The comparison happens here rather than in SQL because the key is derived,
 * not stored on Candidate, and a database-side `equals` on the raw columns
 * would disagree with referralNameKey about accents and punctuation - which is
 * exactly the mismatch that would leave a referral pending forever. The scan is
 * bounded to candidates who applied in this cycle, which is the only set a
 * referral can attach to.
 */
export async function candidateIdsMatchingName({ nameKey, cycleId, client = prisma }) {
  if (!nameKey) return [];

  const candidates = await client.candidate.findMany({
    where: cycleId ? { applications: { some: { cycleId } } } : {},
    select: { id: true, firstName: true, lastName: true }
  });

  return candidates
    .filter((candidate) => referralNameKey(candidate.firstName, candidate.lastName) === nameKey)
    .map((candidate) => candidate.id);
}
