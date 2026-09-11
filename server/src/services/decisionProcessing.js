import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import prisma from '../prismaClient.js';
import { invalidateUserCache } from '../middleware/auth.js';
import { EXEC_ACCESS_ACTIONS, lockCandidateRecords } from './execAccess.js';
import { defaultDecisionTemplates } from './decisionTemplates.js';
import { ACCEPTED_ROUND, getRound, isFinalRound, nextRound } from '../utils/roundProgression.js';

// "Process All Decisions" on Staging, for one round.
//
// Processing moves application state and sends nothing:
// - "yes" in rounds 1-3 advances the application to the next round;
// - "yes" in the final round accepts it, makes the person a MEMBER (creating
//   their account if they have none) and seals their recruiting record;
// - "no" rejects it.
// Every decision applied is queued as a DecisionMessage in one DecisionBatch,
// which an admin reviews and sends from Master Communications
// (services/decisionBatches.js).
//
// Running a round twice is harmless. Applications already ACCEPTED or REJECTED
// are left alone, and DecisionMessage is unique per application, round and
// outcome, so no decision can be queued - or emailed - twice.

const SETTLED_STATUSES = ['ACCEPTED', 'REJECTED'];

// Account lookups and bcrypt hashing happen before the transaction so it only
// writes; these are the same limits Staging's snapshot read uses.
const TRANSACTION_OPTIONS = { maxWait: 10 * 1000, timeout: 30 * 1000 };

const APPLICATION_SELECT = {
  id: true,
  candidateId: true,
  email: true,
  firstName: true,
  lastName: true,
  studentId: true,
  graduationYear: true,
  status: true,
  approved: true,
  currentRound: true,
  resumeDecision: true,
  coffeeChatDecision: true,
  firstRoundDecision: true,
  finalRoundDecision: true
};

const USER_SELECT = { id: true, role: true, isActive: true };

/**
 * 'yes', 'no', or null for an application's decision in `round`. The round's
 * own column is the answer. Resume review predates those columns, so an older
 * resume decision may live only in `approved`; later rounds never fall back to
 * it, because `approved` is shared by every round and a first-round "yes" left
 * there would otherwise read as a final-round "yes".
 */
export function decisionFor(application, round) {
  const recorded = application[getRound(round).decisionField];
  if (recorded === 'yes' || recorded === 'no') return recorded;

  if (String(round) === '1') {
    if (application.approved === true) return 'yes';
    if (application.approved === false) return 'no';
  }
  return null;
}

/** What processing `round` does to each application. Pure. */
export function planDecisions(applications, round) {
  const plan = { advance: [], accept: [], reject: [], undecided: [], settled: [] };
  const final = isFinalRound(round);

  for (const application of applications) {
    if (SETTLED_STATUSES.includes(application.status)) {
      plan.settled.push(application);
      continue;
    }
    const decision = decisionFor(application, round);
    if (decision === 'no') plan.reject.push(application);
    else if (decision === 'yes') (final ? plan.accept : plan.advance).push(application);
    else plan.undecided.push(application);
  }

  return plan;
}

const fullNameOf = (application) =>
  [application.firstName, application.lastName].filter(Boolean).join(' ').trim();

/**
 * The account a final-round acceptance becomes a member through. Matched on
 * student ID, then email ignoring case - there is no foreign key from
 * Application to User. A match that cannot safely be promoted is returned as a
 * conflict, for an admin to sort out, instead of guessing.
 */
async function resolveMembership(application, client) {
  const email = application.email?.trim() || null;
  const candidateLookup = [
    ...(application.studentId ? [{ studentId: application.studentId }] : []),
    ...(email ? [{ email }] : [])
  ];

  const [byStudentId, byEmail, candidate] = await Promise.all([
    application.studentId
      ? client.user.findUnique({ where: { studentId: application.studentId }, select: USER_SELECT })
      : null,
    email
      ? client.user.findFirst({ where: { email: { equals: email, mode: 'insensitive' } }, select: USER_SELECT })
      : null,
    !application.candidateId && candidateLookup.length
      ? client.candidate.findFirst({ where: { OR: candidateLookup }, select: { id: true } })
      : null
  ]);

  const candidateId = application.candidateId ?? candidate?.id ?? null;
  const user = byStudentId || byEmail;

  let conflict = null;
  if (byStudentId && byEmail && byStudentId.id !== byEmail.id) {
    conflict = 'Their student ID and email belong to two different accounts.';
  } else if (user?.role === 'CLIENT') {
    conflict = 'Their email belongs to a Talent Partner client account.';
  } else if (user && user.isActive === false) {
    conflict = 'Their account is deactivated.';
  } else if (!user && !email) {
    conflict = 'The application has no email address to create an account with.';
  }

  if (conflict) return { application, candidateId, user: null, conflict };
  if (user) return { application, candidateId, user };

  // Unusable on purpose - nobody knows it. The decision email carries a link to
  // set a real password.
  const placeholderHash = await bcrypt.hash(crypto.randomBytes(32).toString('hex'), 12);
  return { application, candidateId, user: null, placeholderHash };
}

const messageFor = (batchId, application, outcome, fromRound, toRound, { userId = null, needsInvite = false } = {}) => ({
  batchId,
  applicationId: application.id,
  candidateId: application.candidateId ?? null,
  userId,
  email: application.email,
  firstName: application.firstName || '',
  lastName: application.lastName || '',
  outcome,
  fromRound,
  toRound,
  needsInvite
});

export async function processRoundDecisions({ cycle, round, processedBy }, client = prisma) {
  const roundInfo = getRound(round);
  if (!roundInfo) {
    throw Object.assign(new Error(`Unknown round: ${round}`), { status: 400 });
  }

  const applications = await client.application.findMany({
    where: { cycleId: cycle.id, currentRound: roundInfo.round, status: { notIn: SETTLED_STATUSES } },
    select: APPLICATION_SELECT
  });

  const plan = planDecisions(applications, roundInfo.round);
  const next = nextRound(roundInfo.round);
  const decidedCount = plan.advance.length + plan.accept.length + plan.reject.length;

  const summary = {
    round: roundInfo.round,
    roundLabel: roundInfo.label,
    nextRoundLabel: next?.label ?? null,
    processed: decidedCount,
    advanced: plan.advance.length,
    accepted: plan.accept.length,
    rejected: plan.reject.length,
    undecided: plan.undecided.length,
    emailsQueued: 0,
    membersPromoted: 0,
    membersCreated: 0,
    recordsSealed: 0,
    conflicts: []
  };

  if (decidedCount === 0) {
    return { batchId: null, summary };
  }

  const memberships = [];
  for (const application of plan.accept) {
    memberships.push(await resolveMembership(application, client));
  }

  const promotedUserIds = [];

  const written = await client.$transaction(async (tx) => {
    const batch = await tx.decisionBatch.create({
      data: {
        cycleId: cycle.id,
        round: roundInfo.round,
        templates: defaultDecisionTemplates(roundInfo.round),
        processedById: processedBy.id
      },
      select: { id: true }
    });

    // Re-checked on write, so an application that changed since it was read
    // above is not moved on stale information.
    const stillOpenAtRound = { currentRound: roundInfo.round, status: { notIn: SETTLED_STATUSES } };
    const idsOf = (list) => list.map((application) => application.id);

    if (plan.advance.length) {
      await tx.application.updateMany({
        where: { id: { in: idsOf(plan.advance) }, ...stillOpenAtRound },
        // approved is shared by every round. Clearing it keeps this round's
        // "yes" from being read as the next round's decision.
        data: { status: 'UNDER_REVIEW', currentRound: next.round, approved: null }
      });
    }
    if (plan.reject.length) {
      await tx.application.updateMany({
        where: { id: { in: idsOf(plan.reject) }, ...stillOpenAtRound },
        data: { status: 'REJECTED', approved: false }
      });
    }
    if (plan.accept.length) {
      await tx.application.updateMany({
        where: { id: { in: idsOf(plan.accept) }, ...stillOpenAtRound },
        data: { status: 'ACCEPTED', currentRound: ACCEPTED_ROUND, approved: true }
      });
    }

    const messages = [
      ...plan.advance.map((application) => messageFor(batch.id, application, 'ADVANCED', roundInfo.round, next.round)),
      ...plan.reject.map((application) => messageFor(batch.id, application, 'REJECTED', roundInfo.round, null))
    ];

    let membersPromoted = 0;
    let membersCreated = 0;
    let recordsSealed = 0;

    for (const membership of memberships) {
      const { application } = membership;
      let userId = membership.user?.id ?? null;
      let needsInvite = false;

      if (membership.user?.role === 'USER') {
        await tx.user.update({
          where: { id: userId },
          data: { role: 'MEMBER', isExternalTalent: false }
        });
        promotedUserIds.push(userId);
        membersPromoted += 1;
      } else if (membership.placeholderHash) {
        const created = await tx.user.create({
          data: {
            email: application.email.trim().toLowerCase(),
            password: membership.placeholderHash,
            fullName: fullNameOf(application) || application.email,
            studentId: application.studentId || null,
            graduationClass: application.graduationYear || null,
            role: 'MEMBER'
          },
          select: { id: true }
        });
        userId = created.id;
        needsInvite = true;
        membersCreated += 1;
      }

      // Sealed even when the account needs an admin's attention: they are a
      // member either way, and the seal is what keeps their file private.
      if (membership.candidateId) {
        const sealed = await lockCandidateRecords(
          membership.candidateId,
          { userId: processedBy.id, action: EXEC_ACCESS_ACTIONS.AUTO_LOCK },
          tx
        );
        if (sealed) recordsSealed += 1;
      }

      messages.push(messageFor(batch.id, application, 'ACCEPTED', roundInfo.round, ACCEPTED_ROUND, { userId, needsInvite }));
    }

    const { count: emailsQueued } = await tx.decisionMessage.createMany({ data: messages, skipDuplicates: true });

    return { batchId: batch.id, emailsQueued, membersPromoted, membersCreated, recordsSealed };
  }, TRANSACTION_OPTIONS);

  // Roles are read through a five-minute auth cache; without this a new member
  // keeps an applicant's view until it expires.
  invalidateUserCache(promotedUserIds);

  return {
    batchId: written.batchId,
    summary: {
      ...summary,
      emailsQueued: written.emailsQueued,
      membersPromoted: written.membersPromoted,
      membersCreated: written.membersCreated,
      recordsSealed: written.recordsSealed,
      conflicts: memberships
        .filter((membership) => membership.conflict)
        .map(({ application, conflict }) => ({
          applicationId: application.id,
          name: fullNameOf(application),
          email: application.email,
          reason: conflict
        }))
    }
  };
}
