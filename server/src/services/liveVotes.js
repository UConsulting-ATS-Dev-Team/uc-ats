import crypto from 'node:crypto';
import prisma from '../prismaClient.js';
import config from '../config.js';
import { resolveAdminCycle } from './activeCycle.js';
import { isOwnedBy } from '../utils/applicationOwnership.js';
import { sealedApplicationIds } from '../utils/lockedRecords.js';
import { isDecisionValue, phaseLabel, roundForPhase, saveRoundDecision } from './stagingDecisions.js';
import { PRESENCE_WINDOW_MS, buildState, computeEligible, presentParticipants } from './liveVoteState.js';
import { nudgeLiveVote, nudgeLiveVotesGlobal } from './realtime.js';

// Live vote deliberations on Staging.
//
// An admin launches a session on one round with a list of candidates. Admins and
// members join from anywhere in the app; any admin who has joined can run it -
// begin, close a vote, re-open it, apply a decision, move on - so the session
// survives its creator losing wifi. Everyone who has joined votes yes or no.
//
// Concurrency: every change to a session runs inside withSessionLock, whose
// first statement bumps the session's version and so holds its row lock until
// commit. Votes, closes and navigation on one session are therefore serialized:
// a vote that arrives while a close is committing waits, then sees the ballot
// CLOSED and is refused, which is what guarantees a closed ballot's frozen
// counts equal the votes stored against it. Two partial unique indexes back the
// invariants the lock does not cover (one open session, one open ballot).
//
// Anonymity: a vote row holds HMAC(secret, ballotId:userId), not a user. The
// server can recompute a viewer's own key to answer "what did I vote"; nobody
// reading the table can go the other way.

const TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 };
const HEARTBEAT_EVERY_MS = 5_000;
const STATE_CACHE_TTL_MS = 1_000;
const MAX_CANDIDATES = 100;
const MAX_CRITERIA = 20;

export const PHASES = Object.freeze(['resume', 'coffee', 'firstRound', 'final']);

const fail = (status, message, code, extra = {}) =>
  Object.assign(new Error(message), { status, code, ...extra });

export const voterKey = (ballotId, userId) =>
  crypto.createHmac('sha256', config.liveVoteSecret || '').update(`${ballotId}:${userId}`).digest('hex');

const OWNERSHIP_SELECT = {
  id: true,
  email: true,
  studentId: true,
  candidateId: true,
  candidate: { select: { email: true, studentId: true } }
};

const CARD_SELECT = {
  ...OWNERSHIP_SELECT,
  firstName: true,
  lastName: true,
  major1: true,
  graduationYear: true,
  headshotUrl: true,
  resumeUrl: true,
  resumeDecision: true,
  coffeeChatDecision: true,
  firstRoundDecision: true,
  finalRoundDecision: true
};

const assertPhase = (phase) => {
  if (!roundForPhase(phase)) throw fail(400, `Unknown round: ${phase}`, 'INVALID_PHASE');
};

// ---------------------------------------------------------------------------
// Rubrics
// ---------------------------------------------------------------------------

/** Validates and trims rubric criteria. Missing ids are filled in. */
export function normalizeCriteria(input) {
  if (!Array.isArray(input)) throw fail(400, 'Rubric criteria must be a list', 'INVALID_RUBRIC');
  if (input.length > MAX_CRITERIA) {
    throw fail(400, `A rubric can have at most ${MAX_CRITERIA} criteria`, 'INVALID_RUBRIC');
  }
  return input.map((item, index) => {
    const title = typeof item?.title === 'string' ? item.title.trim() : '';
    const description = typeof item?.description === 'string' ? item.description.trim() : '';
    if (!title || title.length > 120) {
      throw fail(400, `Criterion ${index + 1} needs a title of at most 120 characters`, 'INVALID_RUBRIC');
    }
    if (description.length > 2000) {
      throw fail(400, `Criterion ${index + 1}'s description is over 2000 characters`, 'INVALID_RUBRIC');
    }
    const id = typeof item?.id === 'string' && item.id && item.id.length <= 64 ? item.id : crypto.randomUUID();
    return { id, title, description };
  });
}

export async function getRubrics({ client = prisma } = {}) {
  const rows = await client.deliberationRubric.findMany();
  const rubrics = Object.fromEntries(PHASES.map((phase) => [phase, null]));
  for (const row of rows) {
    if (row.phase in rubrics) {
      rubrics[row.phase] = { criteria: Array.isArray(row.criteria) ? row.criteria : [], updatedAt: row.updatedAt };
    }
  }
  return { rubrics };
}

export async function saveRubric({ client = prisma, phase, criteria, user }) {
  assertPhase(phase);
  const normalized = normalizeCriteria(criteria);
  const row = await client.deliberationRubric.upsert({
    where: { phase },
    create: { phase, criteria: normalized, updatedById: user.id },
    update: { criteria: normalized, updatedById: user.id }
  });
  return { phase, criteria: row.criteria, updatedAt: row.updatedAt };
}

// ---------------------------------------------------------------------------
// Locking and shared steps
// ---------------------------------------------------------------------------

/**
 * Runs `fn(tx, session)` holding the session's row lock and returns
 * `{ result, version }`. The version bump is the first statement on purpose: it
 * is what takes the lock, and it rolls back with everything else if `fn` throws.
 */
export async function withSessionLock(client, sessionId, fn) {
  return client.$transaction(async (tx) => {
    let session;
    try {
      session = await tx.liveVoteSession.update({
        where: { id: sessionId },
        data: { version: { increment: 1 } }
      });
    } catch (error) {
      if (error?.code === 'P2025') throw fail(404, 'Live vote not found', 'NOT_FOUND');
      throw error;
    }
    const result = await fn(tx, session);
    return { result, version: session.version };
  }, TX_OPTIONS);
}

const assertStatus = (session, ...statuses) => {
  if (statuses.includes(session.status)) return;
  if (session.status === 'ENDED') throw fail(409, 'This live vote has ended', 'SESSION_ENDED');
  throw fail(409, `This live vote is ${session.status.toLowerCase()}`, 'INVALID_STATE');
};

async function assertHost(tx, session, user) {
  if (user?.role !== 'ADMIN') throw fail(403, 'Only admins can run a live vote', 'FORBIDDEN');
  const participant = await tx.liveVoteParticipant.findUnique({
    where: { sessionId_userId: { sessionId: session.id, userId: user.id } },
    select: { leftAt: true }
  });
  if (!participant || participant.leftAt) {
    throw fail(403, 'Join the live vote to run it', 'JOIN_REQUIRED');
  }
}

const findOpenBallot = (tx, sessionId) =>
  tx.liveVoteBallot.findFirst({ where: { sessionId, status: 'OPEN' } });

const candidateAt = (tx, sessionId, position) =>
  tx.liveVoteSessionCandidate.findFirst({
    where: { sessionId, position },
    include: { application: { select: OWNERSHIP_SELECT } }
  });

const openBallot = (tx, { sessionId, sessionCandidateId, roundNumber, userId }) =>
  tx.liveVoteBallot.create({
    data: { sessionId, sessionCandidateId, roundNumber, openedById: userId }
  });

/**
 * Closes `ballot`, freezing its counts. Caller holds the session lock.
 *
 * With `discardIfEmpty`, a ballot nobody voted on is deleted instead. That is for
 * ballots closed as a side effect - moving on, ending the session - where an
 * untouched ballot means "we skipped this one", not "the room voted 0-0", and
 * recording it would put a meaningless result on the candidate's Staging row.
 * An admin pressing Close always records, even at zero.
 */
async function freezeBallot(tx, ballot, userId, { discardIfEmpty = false, now = new Date() } = {}) {
  const [votes, participants, entry] = await Promise.all([
    tx.liveVoteVote.findMany({ where: { ballotId: ballot.id }, select: { voterKey: true, value: true } }),
    tx.liveVoteParticipant.findMany({
      where: { sessionId: ballot.sessionId },
      select: { userId: true, lastSeenAt: true, leftAt: true, user: { select: { email: true, studentId: true } } }
    }),
    tx.liveVoteSessionCandidate.findUnique({
      where: { id: ballot.sessionCandidateId },
      include: { application: { select: OWNERSHIP_SELECT } }
    })
  ]);

  if (discardIfEmpty && votes.length === 0) {
    return tx.liveVoteBallot.delete({ where: { id: ballot.id } });
  }

  const yesCount = votes.filter((vote) => vote.value === 'YES').length;
  return tx.liveVoteBallot.update({
    where: { id: ballot.id },
    data: {
      status: 'CLOSED',
      closedAt: now,
      closedById: userId,
      yesCount,
      noCount: votes.length - yesCount,
      eligibleCount: computeEligible({
        present: presentParticipants(participants, now.getTime()),
        votes,
        ballotId: ballot.id,
        application: entry?.application,
        keyFor: voterKey
      })
    }
  });
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export async function launchSession({
  client = prisma,
  user,
  phase,
  applicationIds,
  rubricCriteria,
  saveRubricAsDefault = false
}) {
  assertPhase(phase);
  if (!Array.isArray(applicationIds)) {
    throw fail(400, 'Choose at least one candidate', 'INVALID_CANDIDATES');
  }
  const ids = [...new Set(applicationIds.filter((id) => typeof id === 'string' && id))];
  if (!ids.length) throw fail(400, 'Choose at least one candidate', 'INVALID_CANDIDATES');
  if (ids.length > MAX_CANDIDATES) {
    throw fail(400, `A live vote can have at most ${MAX_CANDIDATES} candidates`, 'INVALID_CANDIDATES');
  }

  const cycle = await resolveAdminCycle(client);
  if (!cycle) throw fail(400, 'No active recruiting cycle', 'NO_CYCLE');

  const [applications, sealed] = await Promise.all([
    client.application.findMany({
      where: { id: { in: ids }, cycleId: cycle.id },
      select: { ...OWNERSHIP_SELECT, firstName: true, lastName: true }
    }),
    sealedApplicationIds(ids, client)
  ]);
  const byId = new Map(applications.map((application) => [application.id, application]));

  const rejected = [];
  for (const id of ids) {
    const application = byId.get(id);
    const name = application ? `${application.firstName} ${application.lastName}`.trim() : null;
    if (!application) rejected.push({ applicationId: id, name, reason: 'NOT_IN_CYCLE' });
    else if (sealed.has(id)) rejected.push({ applicationId: id, name, reason: 'SEALED' });
    else if (isOwnedBy(application, user)) rejected.push({ applicationId: id, name, reason: 'OWN_RECORD' });
  }
  if (rejected.length) {
    throw fail(422, 'Some candidates cannot be voted on', 'INVALID_CANDIDATES', { rejected });
  }

  const criteria = rubricCriteria !== undefined && rubricCriteria !== null
    ? normalizeCriteria(rubricCriteria)
    : null;

  let session;
  try {
    session = await client.$transaction(async (tx) => {
      let rubric = criteria;
      if (criteria && saveRubricAsDefault) {
        await tx.deliberationRubric.upsert({
          where: { phase },
          create: { phase, criteria, updatedById: user.id },
          update: { criteria, updatedById: user.id }
        });
      }
      if (!rubric) {
        const stored = await tx.deliberationRubric.findUnique({ where: { phase } });
        rubric = Array.isArray(stored?.criteria) ? stored.criteria : [];
      }

      return tx.liveVoteSession.create({
        data: {
          cycleId: cycle.id,
          phase,
          rubric,
          createdById: user.id,
          candidates: {
            create: ids.map((applicationId, position) => ({ applicationId, position }))
          },
          participants: { create: { userId: user.id } }
        },
        select: { id: true, status: true, phase: true }
      });
    }, TX_OPTIONS);
  } catch (error) {
    if (error?.code === 'P2002') {
      const open = await client.liveVoteSession.findFirst({
        where: { status: { in: ['LOBBY', 'ACTIVE'] } },
        select: { id: true }
      });
      throw fail(409, 'A live vote is already running', 'LIVE_VOTE_ACTIVE', { sessionId: open?.id ?? null });
    }
    throw error;
  }

  nudgeLiveVotesGlobal({ sessionId: session.id, status: session.status });
  return { session };
}

export async function getActiveSession({ client = prisma, user }) {
  const session = await client.liveVoteSession.findFirst({
    where: { status: { in: ['LOBBY', 'ACTIVE'] } },
    select: {
      id: true,
      phase: true,
      status: true,
      createdAt: true,
      createdBy: { select: { fullName: true } },
      _count: { select: { candidates: true } },
      participants: { where: { userId: user.id, leftAt: null }, select: { id: true } }
    }
  });
  if (!session) return { session: null };
  return {
    session: {
      id: session.id,
      phase: session.phase,
      phaseLabel: phaseLabel(session.phase),
      status: session.status,
      createdAt: session.createdAt,
      createdByName: session.createdBy?.fullName || null,
      candidateCount: session._count.candidates,
      joined: session.participants.length > 0
    }
  };
}

export async function joinSession({ client = prisma, sessionId, user }) {
  const [session, participant] = await Promise.all([
    client.liveVoteSession.findUnique({ where: { id: sessionId }, select: { status: true } }),
    client.liveVoteParticipant.findUnique({ where: { sessionId_userId: { sessionId, userId: user.id } } })
  ]);
  if (!session) throw fail(404, 'Live vote not found', 'NOT_FOUND');
  assertStatus(session, 'LOBBY', 'ACTIVE');

  const now = Date.now();
  const stillPresent = participant && !participant.leftAt &&
    now - new Date(participant.lastSeenAt).getTime() <= PRESENCE_WINDOW_MS;

  if (stillPresent) {
    // Re-joining from a second tab or a refresh changes nothing anyone can see.
    await client.liveVoteParticipant.update({
      where: { id: participant.id },
      data: { lastSeenAt: new Date(now) }
    });
  } else {
    const { version } = await withSessionLock(client, sessionId, async (tx, locked) => {
      assertStatus(locked, 'LOBBY', 'ACTIVE');
      await tx.liveVoteParticipant.upsert({
        where: { sessionId_userId: { sessionId, userId: user.id } },
        create: { sessionId, userId: user.id },
        update: { lastSeenAt: new Date(now), leftAt: null }
      });
    });
    nudgeLiveVote(sessionId, { version, kind: 'presence' });
  }

  return getState({ client, sessionId, user });
}

export async function leaveSession({ client = prisma, sessionId, user }) {
  const participant = await client.liveVoteParticipant.findUnique({
    where: { sessionId_userId: { sessionId, userId: user.id } },
    select: { leftAt: true }
  });
  if (!participant || participant.leftAt) return;

  const { version } = await withSessionLock(client, sessionId, (tx) =>
    tx.liveVoteParticipant.updateMany({
      where: { sessionId, userId: user.id, leftAt: null },
      data: { leftAt: new Date() }
    })
  );
  nudgeLiveVote(sessionId, { version, kind: 'presence' });
}

export async function beginSession({ client = prisma, sessionId, user }) {
  const { version } = await withSessionLock(client, sessionId, async (tx, session) => {
    assertStatus(session, 'LOBBY');
    await assertHost(tx, session, user);

    const first = await candidateAt(tx, sessionId, 0);
    if (!first) throw fail(409, 'This live vote has no candidates', 'NO_CANDIDATES');

    await tx.liveVoteSession.update({
      where: { id: sessionId },
      data: { status: 'ACTIVE', startedAt: new Date(), currentIndex: 0 }
    });
    await openBallot(tx, { sessionId, sessionCandidateId: first.id, roundNumber: 1, userId: user.id });
  });

  nudgeLiveVote(sessionId, { version, kind: 'control' });
  nudgeLiveVotesGlobal({ sessionId, status: 'ACTIVE' });
  return getState({ client, sessionId, user });
}

export async function castVote({ client = prisma, sessionId, ballotId, value, user }) {
  if (value !== 'YES' && value !== 'NO') throw fail(400, 'Vote YES or NO', 'INVALID_VOTE');

  const { version } = await withSessionLock(client, sessionId, async (tx, session) => {
    assertStatus(session, 'ACTIVE');

    const participant = await tx.liveVoteParticipant.findUnique({
      where: { sessionId_userId: { sessionId, userId: user.id } },
      select: { id: true }
    });
    if (!participant) throw fail(403, 'Join the live vote first', 'NOT_JOINED');

    const ballot = await tx.liveVoteBallot.findFirst({
      where: { id: ballotId, sessionId },
      include: { sessionCandidate: { include: { application: { select: OWNERSHIP_SELECT } } } }
    });
    if (!ballot || ballot.status !== 'OPEN') {
      throw fail(409, 'Voting on this candidate has closed', 'BALLOT_CLOSED');
    }
    if (isOwnedBy(ballot.sessionCandidate.application, user)) {
      throw fail(403, 'You cannot vote on your own application', 'OWN_RECORD');
    }

    const key = voterKey(ballot.id, user.id);
    await tx.liveVoteVote.upsert({
      where: { ballotId_voterKey: { ballotId: ballot.id, voterKey: key } },
      create: { ballotId: ballot.id, voterKey: key, value },
      update: { value }
    });
    // Voting is proof of presence; also clears a leave from a flaky pagehide.
    await tx.liveVoteParticipant.update({
      where: { id: participant.id },
      data: { lastSeenAt: new Date(), leftAt: null }
    });
  });

  nudgeLiveVote(sessionId, { version, kind: 'vote' });
  return { ballotId, myVote: value, version };
}

export async function closeBallot({ client = prisma, sessionId, ballotId, user }) {
  const { version } = await withSessionLock(client, sessionId, async (tx, session) => {
    assertStatus(session, 'ACTIVE');
    await assertHost(tx, session, user);

    const open = await findOpenBallot(tx, sessionId);
    if (!open || (ballotId && open.id !== ballotId)) {
      throw fail(409, 'That vote is already closed', 'BALLOT_NOT_OPEN');
    }
    await freezeBallot(tx, open, user.id);
  });

  nudgeLiveVote(sessionId, { version, kind: 'control' });
  return getState({ client, sessionId, user });
}

export async function reopenBallot({ client = prisma, sessionId, sessionCandidateId, user }) {
  const { version } = await withSessionLock(client, sessionId, async (tx, session) => {
    assertStatus(session, 'ACTIVE');
    await assertHost(tx, session, user);

    const current = await candidateAt(tx, sessionId, session.currentIndex);
    if (!current || current.id !== sessionCandidateId) {
      throw fail(409, 'The live vote has moved to another candidate', 'STALE_INDEX');
    }
    if (await findOpenBallot(tx, sessionId)) {
      throw fail(409, 'Voting is already open', 'BALLOT_ALREADY_OPEN');
    }

    const { _max } = await tx.liveVoteBallot.aggregate({
      where: { sessionCandidateId },
      _max: { roundNumber: true }
    });
    await openBallot(tx, {
      sessionId,
      sessionCandidateId,
      roundNumber: (_max.roundNumber ?? 0) + 1,
      userId: user.id
    });
  });

  nudgeLiveVote(sessionId, { version, kind: 'control' });
  return getState({ client, sessionId, user });
}

export async function navigateSession({ client = prisma, sessionId, fromIndex, toIndex, user }) {
  if (!Number.isInteger(fromIndex) || !Number.isInteger(toIndex)) {
    throw fail(400, 'fromIndex and toIndex must be whole numbers', 'INVALID_INDEX');
  }

  const { version } = await withSessionLock(client, sessionId, async (tx, session) => {
    assertStatus(session, 'ACTIVE');
    await assertHost(tx, session, user);

    // Two admins pressing Next together both send the index they were looking at;
    // only the first moves the session.
    if (session.currentIndex !== fromIndex) {
      throw fail(409, 'The live vote has moved to another candidate', 'STALE_INDEX');
    }
    const count = await tx.liveVoteSessionCandidate.count({ where: { sessionId } });
    if (toIndex < 0 || toIndex >= count) throw fail(400, 'No candidate at that position', 'INVALID_INDEX');

    const open = await findOpenBallot(tx, sessionId);
    if (open) await freezeBallot(tx, open, user.id, { discardIfEmpty: true });

    await tx.liveVoteSession.update({ where: { id: sessionId }, data: { currentIndex: toIndex } });

    // A candidate with no recorded vote opens for voting straight away; one
    // already voted on shows its result until someone re-opens it.
    const target = await candidateAt(tx, sessionId, toIndex);
    const voted = await tx.liveVoteBallot.count({ where: { sessionCandidateId: target.id } });
    if (!voted) {
      await openBallot(tx, { sessionId, sessionCandidateId: target.id, roundNumber: 1, userId: user.id });
    }
  });

  nudgeLiveVote(sessionId, { version, kind: 'control' });
  return getState({ client, sessionId, user });
}

export async function applyDecision({ client = prisma, sessionId, sessionCandidateId, decision, user }) {
  if (!isDecisionValue(decision)) throw fail(400, `Unknown decision: ${decision}`, 'INVALID_DECISION');

  const { version } = await withSessionLock(client, sessionId, async (tx, session) => {
    assertStatus(session, 'ACTIVE');
    await assertHost(tx, session, user);

    const entry = await tx.liveVoteSessionCandidate.findFirst({
      where: { id: sessionCandidateId, sessionId },
      include: { application: { select: OWNERSHIP_SELECT } }
    });
    if (!entry) throw fail(404, 'That candidate is not in this live vote', 'NOT_FOUND');

    const open = await tx.liveVoteBallot.findFirst({ where: { sessionCandidateId, status: 'OPEN' } });
    if (open) throw fail(409, 'Close voting before setting a decision', 'BALLOT_OPEN');

    if ((await sealedApplicationIds([entry.applicationId], tx)).has(entry.applicationId)) {
      throw fail(423, 'This record is sealed', 'RECORD_LOCKED');
    }
    if (isOwnedBy(entry.application, user)) {
      throw fail(403, 'You cannot decide your own application', 'OWN_RECORD');
    }

    await saveRoundDecision({
      client: tx,
      applicationId: entry.applicationId,
      cycleId: session.cycleId,
      phase: session.phase,
      decision,
      userId: user.id
    });

    const latest = await tx.liveVoteBallot.findFirst({
      where: { sessionCandidateId, status: 'CLOSED' },
      orderBy: { roundNumber: 'desc' },
      select: { id: true }
    });
    if (latest) {
      await tx.liveVoteBallot.update({
        where: { id: latest.id },
        data: { decisionApplied: decision, decidedById: user.id, decidedAt: new Date() }
      });
    }
  });

  nudgeLiveVote(sessionId, { version, kind: 'control' });
  return getState({ client, sessionId, user });
}

export async function endSession({ client = prisma, sessionId, user }) {
  if (user?.role !== 'ADMIN') throw fail(403, 'Only admins can end a live vote', 'FORBIDDEN');

  const { version } = await withSessionLock(client, sessionId, async (tx, session) => {
    assertStatus(session, 'LOBBY', 'ACTIVE');
    const open = await findOpenBallot(tx, sessionId);
    if (open) await freezeBallot(tx, open, user.id, { discardIfEmpty: true });
    await tx.liveVoteSession.update({
      where: { id: sessionId },
      data: { status: 'ENDED', endedAt: new Date(), endedById: user.id }
    });
  });

  nudgeLiveVote(sessionId, { version, kind: 'control' });
  nudgeLiveVotesGlobal({ sessionId, status: 'ENDED' });
  return getState({ client, sessionId, user });
}

// ---------------------------------------------------------------------------
// Reading state
// ---------------------------------------------------------------------------

// Everyone in the room polls the same session, so the database read behind a
// state response is shared for a moment between viewers at the same version.
// Keyed on the version read from the database, so it is correct across
// instances; the TTL bounds how stale presence can look.
const stateCache = new Map();

export const clearStateCache = () => stateCache.clear();

async function loadRaw(client, sessionId) {
  const session = await client.liveVoteSession.findUnique({
    where: { id: sessionId },
    include: {
      createdBy: { select: { id: true, fullName: true } },
      candidates: { orderBy: { position: 'asc' }, include: { application: { select: CARD_SELECT } } },
      participants: {
        select: {
          userId: true,
          lastSeenAt: true,
          leftAt: true,
          user: { select: { id: true, fullName: true, email: true, studentId: true } }
        }
      },
      ballots: true
    }
  });
  if (!session) return null;

  const open = session.ballots.find((ballot) => ballot.status === 'OPEN');
  const [openVotes, sealed] = await Promise.all([
    open
      ? client.liveVoteVote.findMany({ where: { ballotId: open.id }, select: { voterKey: true, value: true } })
      : [],
    sealedApplicationIds(session.candidates.map((entry) => entry.applicationId), client)
  ]);

  const { candidates, participants, ballots, ...rest } = session;
  return { session: rest, candidates, participants, ballots, openVotes, sealedApplicationIds: sealed };
}

export async function getState({ client = prisma, sessionId, user, now = Date.now() }) {
  const head = await client.liveVoteSession.findUnique({
    where: { id: sessionId },
    select: { version: true }
  });
  if (!head) throw fail(404, 'Live vote not found', 'NOT_FOUND');

  let raw;
  const cached = stateCache.get(sessionId);
  if (cached && cached.version === head.version && now - cached.at <= STATE_CACHE_TTL_MS) {
    raw = cached.raw;
  } else {
    raw = await loadRaw(client, sessionId);
    if (!raw) throw fail(404, 'Live vote not found', 'NOT_FOUND');
    stateCache.set(sessionId, { version: raw.session.version, raw, at: now });
  }

  const mine = raw.participants.find((participant) => participant.userId === user.id);
  if (raw.session.status !== 'ENDED' && (!mine || mine.leftAt)) {
    throw fail(403, 'Join the live vote first', 'NOT_JOINED');
  }

  // Heartbeat. Throttled, and deliberately not a version bump: presence is worked
  // out at read time, so a poll that only says "still here" changes nothing.
  if (mine && !mine.leftAt && now - new Date(mine.lastSeenAt).getTime() > HEARTBEAT_EVERY_MS) {
    const seenAt = new Date(now);
    await client.liveVoteParticipant.updateMany({
      where: { sessionId, userId: user.id, leftAt: null },
      data: { lastSeenAt: seenAt }
    });
    mine.lastSeenAt = seenAt;
  }

  return buildState(raw, { user, keyFor: voterKey }, now);
}
