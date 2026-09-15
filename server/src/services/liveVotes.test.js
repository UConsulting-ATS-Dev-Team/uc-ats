// The live vote state machine, run against an in-memory database. What matters:
// counts freeze on close and match the votes, stale or doubled host actions are
// refused instead of applied twice, nobody votes on or decides their own record,
// and a decision lands in the same Staging column the inline picker writes.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  applyDecision,
  beginSession,
  castVote,
  clearStateCache,
  closeBallot,
  endSession,
  getActiveSession,
  getState,
  joinSession,
  launchSession,
  leaveSession,
  navigateSession,
  normalizeCriteria,
  reopenBallot,
  saveRubric,
  voterKey
} from './liveVotes.js';
import { nudgeLiveVote, nudgeLiveVotesGlobal } from './realtime.js';

vi.mock('../prismaClient.js', () => ({ default: {} }));
vi.mock('./realtime.js', () => ({ nudgeLiveVote: vi.fn(), nudgeLiveVotesGlobal: vi.fn() }));

// ---------------------------------------------------------------------------
// A small in-memory Prisma: only the calls the live vote service makes.
// ---------------------------------------------------------------------------

let seq = 0;
const uid = (prefix) => `${prefix}-${++seq}`;

const matchValue = (actual, expected) => {
  if (expected && typeof expected === 'object' && !(expected instanceof Date)) {
    if ('in' in expected) return expected.in.includes(actual);
    if ('not' in expected) return expected.not === null ? actual != null : actual !== expected.not;
    if ('lt' in expected) return actual < expected.lt;
  }
  return actual === expected;
};

const matches = (row, where = {}) =>
  Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') return expected.some((clause) => matches(row, clause));
    if (key.includes('_') && expected && typeof expected === 'object' && !('in' in expected)) {
      return matches(row, expected); // compound unique, e.g. sessionId_userId
    }
    return matchValue(row[key], expected);
  });

function fakeDb({ users, applications, candidates = [], cycle = { id: 'cycle-1', isActive: true } }) {
  const tables = {
    liveVoteSession: [],
    liveVoteSessionCandidate: [],
    liveVoteBallot: [],
    liveVoteVote: [],
    liveVoteParticipant: [],
    deliberationRubric: [],
    comment: []
  };
  const appRows = applications.map((row) => ({ ...row }));
  const find = (table, where) => tables[table].find((row) => matches(row, where)) || null;
  const filter = (table, where) => tables[table].filter((row) => matches(row, where));
  const userById = (id) => users.find((user) => user.id === id);
  const appById = (id) => appRows.find((row) => row.id === id);
  const withApplication = (entry) => entry && { ...entry, application: appById(entry.applicationId) };
  const withUser = (row) => ({ ...row, user: userById(row.userId) });

  const genericUpdate = (table) => ({ where, data }) => {
    const row = find(table, where);
    if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' });
    for (const [key, value] of Object.entries(data)) {
      row[key] = value && typeof value === 'object' && 'increment' in value ? row[key] + value.increment : value;
    }
    return { ...row };
  };

  const client = {
    tables,
    recruitingCycle: { findFirst: vi.fn(async () => cycle) },
    candidate: { findMany: vi.fn(async ({ where }) => candidates.filter((row) => matches(row, where))) },
    application: {
      findMany: vi.fn(async ({ where }) => appRows.filter((row) => matches(row, where))),
      findFirst: vi.fn(async ({ where }) => appRows.find((row) => matches(row, where)) || null),
      update: vi.fn(async ({ where, data }) => {
        const row = appById(where.id);
        const { comments, ...fields } = data;
        Object.assign(row, fields);
        if (comments?.create) tables.comment.push({ applicationId: row.id, ...comments.create });
        return { ...row };
      })
    },
    deliberationRubric: {
      findUnique: vi.fn(async ({ where }) => find('deliberationRubric', where)),
      findMany: vi.fn(async () => tables.deliberationRubric),
      upsert: vi.fn(async ({ where, create, update }) => {
        const row = find('deliberationRubric', where);
        if (row) Object.assign(row, update, { updatedAt: new Date() });
        else tables.deliberationRubric.push({ id: uid('rubric'), ...create, updatedAt: new Date() });
        return find('deliberationRubric', where);
      })
    },
    liveVoteSession: {
      create: vi.fn(async ({ data }) => {
        if (tables.liveVoteSession.some((row) => row.status !== 'ENDED')) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        const { candidates: nestedCandidates, participants, ...fields } = data;
        const session = {
          id: uid('session'), status: 'LOBBY', version: 0, currentIndex: null, startedAt: null,
          endedAt: null, createdAt: new Date(), ...fields
        };
        tables.liveVoteSession.push(session);
        for (const entry of nestedCandidates.create) {
          tables.liveVoteSessionCandidate.push({ id: uid('sc'), sessionId: session.id, ...entry });
        }
        tables.liveVoteParticipant.push({
          id: uid('p'), sessionId: session.id, joinedAt: new Date(), lastSeenAt: new Date(), leftAt: null,
          ...participants.create
        });
        return { id: session.id, status: session.status, phase: session.phase };
      }),
      update: vi.fn(genericUpdate('liveVoteSession')),
      findUnique: vi.fn(async ({ where, include }) => {
        const session = find('liveVoteSession', where);
        if (!session) return null;
        if (!include) return { ...session };
        return {
          ...session,
          createdBy: userById(session.createdById),
          candidates: filter('liveVoteSessionCandidate', { sessionId: session.id })
            .sort((a, b) => a.position - b.position)
            .map(withApplication),
          participants: filter('liveVoteParticipant', { sessionId: session.id }).map(withUser),
          ballots: filter('liveVoteBallot', { sessionId: session.id }).map((row) => ({ ...row }))
        };
      }),
      findFirst: vi.fn(async ({ where, select }) => {
        const session = find('liveVoteSession', where);
        if (!session) return null;
        if (!select?._count) return { id: session.id };
        return {
          ...session,
          createdBy: userById(session.createdById),
          _count: { candidates: filter('liveVoteSessionCandidate', { sessionId: session.id }).length },
          participants: filter('liveVoteParticipant', { sessionId: session.id, ...select.participants.where })
        };
      })
    },
    liveVoteSessionCandidate: {
      findFirst: vi.fn(async ({ where }) => withApplication(find('liveVoteSessionCandidate', where))),
      findUnique: vi.fn(async ({ where }) => withApplication(find('liveVoteSessionCandidate', where))),
      count: vi.fn(async ({ where }) => filter('liveVoteSessionCandidate', where).length)
    },
    liveVoteBallot: {
      findFirst: vi.fn(async ({ where, include, orderBy }) => {
        let rows = filter('liveVoteBallot', where);
        if (orderBy?.roundNumber === 'desc') rows = rows.sort((a, b) => b.roundNumber - a.roundNumber);
        const row = rows[0];
        if (!row) return null;
        if (!include) return { ...row };
        return { ...row, sessionCandidate: withApplication(find('liveVoteSessionCandidate', { id: row.sessionCandidateId })) };
      }),
      create: vi.fn(async ({ data }) => {
        if (tables.liveVoteBallot.some((row) => row.sessionId === data.sessionId && row.status === 'OPEN')) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        const row = { id: uid('ballot'), status: 'OPEN', openedAt: new Date(), decisionApplied: null, ...data };
        tables.liveVoteBallot.push(row);
        return { ...row };
      }),
      update: vi.fn(genericUpdate('liveVoteBallot')),
      delete: vi.fn(async ({ where }) => {
        const index = tables.liveVoteBallot.findIndex((row) => row.id === where.id);
        const [row] = tables.liveVoteBallot.splice(index, 1);
        tables.liveVoteVote = tables.liveVoteVote.filter((vote) => vote.ballotId !== where.id);
        return row;
      }),
      aggregate: vi.fn(async ({ where }) => ({
        _max: { roundNumber: Math.max(0, ...filter('liveVoteBallot', where).map((row) => row.roundNumber)) || null }
      })),
      count: vi.fn(async ({ where }) => filter('liveVoteBallot', where).length)
    },
    liveVoteVote: {
      findMany: vi.fn(async ({ where }) => filter('liveVoteVote', where).map(({ voterKey: key, value }) => ({ voterKey: key, value }))),
      upsert: vi.fn(async ({ where, create, update }) => {
        const row = find('liveVoteVote', where.ballotId_voterKey);
        if (row) Object.assign(row, update);
        else tables.liveVoteVote.push({ id: uid('vote'), ...create });
      })
    },
    liveVoteParticipant: {
      findUnique: vi.fn(async ({ where }) => {
        const row = find('liveVoteParticipant', where.sessionId_userId || where);
        return row && { ...row };
      }),
      findMany: vi.fn(async ({ where }) => filter('liveVoteParticipant', where).map(withUser)),
      update: vi.fn(genericUpdate('liveVoteParticipant')),
      updateMany: vi.fn(async ({ where, data }) => {
        const rows = filter('liveVoteParticipant', where);
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      }),
      upsert: vi.fn(async ({ where, create, update }) => {
        const row = find('liveVoteParticipant', where.sessionId_userId);
        if (row) Object.assign(row, update);
        else tables.liveVoteParticipant.push({ id: uid('p'), joinedAt: new Date(), lastSeenAt: new Date(), leftAt: null, ...create });
      })
    }
  };

  // Rolls back on throw, like a real transaction.
  client.$transaction = vi.fn(async (fn) => {
    const snapshot = structuredClone({ tables, appRows });
    try {
      return await fn(client);
    } catch (error) {
      for (const key of Object.keys(tables)) tables[key] = snapshot.tables[key];
      appRows.splice(0, appRows.length, ...snapshot.appRows);
      throw error;
    }
  });

  return client;
}

// ---------------------------------------------------------------------------

const admin = { id: 'u-admin', role: 'ADMIN', email: 'ada@ucla.edu', fullName: 'Ada Admin' };
const admin2 = { id: 'u-admin2', role: 'ADMIN', email: 'bo@ucla.edu', fullName: 'Bo Admin' };
const member = { id: 'u-member', role: 'MEMBER', email: 'max@ucla.edu', fullName: 'Max Member' };
const member2 = { id: 'u-member2', role: 'MEMBER', email: 'mia@ucla.edu', fullName: 'Mia Member' };

const app = (id, first, email, overrides = {}) => ({
  id, cycleId: 'cycle-1', firstName: first, lastName: 'Test', email, studentId: `${id}-sid`, candidateId: `cand-${id}`,
  candidate: null, major1: 'Economics', graduationYear: '2028', headshotUrl: `/api/files/${id}/image`,
  resumeUrl: `/api/files/${id}/view`, firstRoundDecision: 'maybe_yes', approved: null, ...overrides
});

let db;

beforeEach(() => {
  seq = 0;
  clearStateCache();
  vi.clearAllMocks();
  db = fakeDb({
    users: [admin, admin2, member, member2],
    applications: [
      app('app-1', 'Sam', 'sam@ucla.edu'),
      app('app-2', 'Kim', 'kim@ucla.edu'),
      app('app-3', 'Lee', 'lee@ucla.edu'),
      app('app-admin2', 'Bo', 'bo@ucla.edu'),
      app('app-other-cycle', 'Old', 'old@ucla.edu', { cycleId: 'cycle-0' })
    ],
    candidates: [{ id: 'cand-app-3', studentId: 'app-3-sid', email: 'lee@ucla.edu', recordsLockedAt: new Date() }]
  });
});

const launch = (ids = ['app-1', 'app-2']) =>
  launchSession({ client: db, user: admin, phase: 'firstRound', applicationIds: ids });

async function activeSession({ joiners = [member, admin2] } = {}) {
  const { session } = await launch();
  for (const user of joiners) await joinSession({ client: db, sessionId: session.id, user });
  const state = await beginSession({ client: db, sessionId: session.id, user: admin });
  return { sessionId: session.id, state };
}

const vote = (sessionId, ballotId, user, value) => castVote({ client: db, sessionId, ballotId, value, user });

describe('launchSession', () => {
  it('creates a lobby with the candidates in order and the launcher already joined', async () => {
    const { session } = await launch(['app-2', 'app-1', 'app-2']);
    expect(session.status).toBe('LOBBY');
    expect(db.tables.liveVoteSessionCandidate.map((row) => [row.applicationId, row.position]))
      .toEqual([['app-2', 0], ['app-1', 1]]);
    expect(db.tables.liveVoteParticipant.map((row) => row.userId)).toEqual([admin.id]);
    expect(nudgeLiveVotesGlobal).toHaveBeenCalledWith({ sessionId: session.id, status: 'LOBBY' });
  });

  it('refuses sealed, out-of-cycle and own applications, naming each', async () => {
    const attempt = launchSession({
      client: db, user: admin2, phase: 'firstRound',
      applicationIds: ['app-1', 'app-3', 'app-other-cycle', 'app-admin2']
    });
    await expect(attempt).rejects.toMatchObject({
      status: 422,
      code: 'INVALID_CANDIDATES',
      rejected: [
        { applicationId: 'app-3', reason: 'SEALED' },
        { applicationId: 'app-other-cycle', reason: 'NOT_IN_CYCLE' },
        { applicationId: 'app-admin2', reason: 'OWN_RECORD' }
      ]
    });
    expect(db.tables.liveVoteSession).toHaveLength(0);
  });

  it('answers a second launch with the session already running', async () => {
    const { session } = await launch();
    await expect(launch(['app-2'])).rejects.toMatchObject({ status: 409, code: 'LIVE_VOTE_ACTIVE', sessionId: session.id });
  });

  it('snapshots the stored rubric, or the edited one and optionally saves it as the default', async () => {
    await saveRubric({ client: db, phase: 'firstRound', criteria: [{ title: 'Leadership' }], user: admin });
    const { session } = await launch();
    expect(db.tables.liveVoteSession[0].rubric.map((c) => c.title)).toEqual(['Leadership']);
    await endSession({ client: db, sessionId: session.id, user: admin });

    await launchSession({
      client: db, user: admin, phase: 'firstRound', applicationIds: ['app-1'],
      rubricCriteria: [{ title: 'Structure' }], saveRubricAsDefault: true
    });
    expect(db.tables.liveVoteSession[1].rubric.map((c) => c.title)).toEqual(['Structure']);
    expect(db.tables.deliberationRubric[0].criteria.map((c) => c.title)).toEqual(['Structure']);
  });

  it('rejects an unknown round', async () => {
    await expect(launchSession({ client: db, user: admin, phase: 'lunch', applicationIds: ['app-1'] }))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_PHASE' });
  });
});

describe('joining and the lobby', () => {
  it('lets members join and see who is here, and refuses state to anyone not joined', async () => {
    const { session } = await launch();
    await expect(getState({ client: db, sessionId: session.id, user: member }))
      .rejects.toMatchObject({ status: 403, code: 'NOT_JOINED' });

    const state = await joinSession({ client: db, sessionId: session.id, user: member });
    expect(state.participants.people.map((p) => p.fullName)).toEqual(['Ada Admin', 'Max Member']);
    expect(state.me).toMatchObject({ joined: true, isHost: false });
  });

  it('bumps the version when someone arrives, not when a present participant re-joins', async () => {
    const { session } = await launch();
    const first = await joinSession({ client: db, sessionId: session.id, user: member });
    clearStateCache();
    const again = await joinSession({ client: db, sessionId: session.id, user: member });
    expect(again.version).toBe(first.version);
  });

  it('only lets a joined admin begin', async () => {
    const { session } = await launch();
    await joinSession({ client: db, sessionId: session.id, user: member });
    await expect(beginSession({ client: db, sessionId: session.id, user: member }))
      .rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
    await expect(beginSession({ client: db, sessionId: session.id, user: admin2 }))
      .rejects.toMatchObject({ status: 403, code: 'JOIN_REQUIRED' });

    const state = await beginSession({ client: db, sessionId: session.id, user: admin });
    expect(state.session.status).toBe('ACTIVE');
    expect(state.current).toMatchObject({ position: 0, ballot: { status: 'OPEN', roundNumber: 1 } });
    await expect(beginSession({ client: db, sessionId: session.id, user: admin }))
      .rejects.toMatchObject({ status: 409 });
  });

  it('loses host rights on leaving', async () => {
    const { sessionId, state } = await activeSession();
    await leaveSession({ client: db, sessionId, user: admin2 });
    await expect(closeBallot({ client: db, sessionId, ballotId: state.current.ballot.id, user: admin2 }))
      .rejects.toMatchObject({ code: 'JOIN_REQUIRED' });
  });
});

describe('voting', () => {
  it('keeps one vote per person, changeable until close, then freezes matching counts', async () => {
    const { sessionId, state } = await activeSession();
    const ballotId = state.current.ballot.id;

    await vote(sessionId, ballotId, member, 'YES');
    await vote(sessionId, ballotId, member, 'NO');
    await vote(sessionId, ballotId, admin, 'YES');
    expect(db.tables.liveVoteVote).toHaveLength(2);
    expect(db.tables.liveVoteVote.every((row) => !('userId' in row))).toBe(true);
    expect(db.tables.liveVoteVote.map((row) => row.voterKey)).toContain(voterKey(ballotId, member.id));

    const open = await getState({ client: db, sessionId, user: member });
    expect(open.current.ballot).toMatchObject({ votedCount: 2, eligibleCount: 3, myVote: 'NO' });
    expect(open.current.ballot).not.toHaveProperty('yesCount');

    const closed = await closeBallot({ client: db, sessionId, ballotId, user: admin2 });
    expect(closed.current.ballot).toMatchObject({ status: 'CLOSED', yesCount: 1, noCount: 1, eligibleCount: 3 });

    await expect(vote(sessionId, ballotId, member2, 'YES')).rejects.toMatchObject({ code: 'NOT_JOINED' });
    await expect(vote(sessionId, ballotId, member, 'YES')).rejects.toMatchObject({ status: 409, code: 'BALLOT_CLOSED' });
    expect(db.tables.liveVoteBallot[0]).toMatchObject({ yesCount: 1, noCount: 1 });
  });

  it('nudges the room on votes as a throttled kind, and on control changes immediately', async () => {
    const { sessionId, state } = await activeSession();
    await vote(sessionId, state.current.ballot.id, member, 'YES');
    expect(nudgeLiveVote).toHaveBeenLastCalledWith(sessionId, expect.objectContaining({ kind: 'vote' }));
    await closeBallot({ client: db, sessionId, ballotId: state.current.ballot.id, user: admin });
    expect(nudgeLiveVote).toHaveBeenLastCalledWith(sessionId, expect.objectContaining({ kind: 'control' }));
  });

  it('refuses a vote on your own application', async () => {
    const { session } = await launchSession({ client: db, user: admin, phase: 'firstRound', applicationIds: ['app-admin2'] });
    await joinSession({ client: db, sessionId: session.id, user: admin2 });
    const state = await beginSession({ client: db, sessionId: session.id, user: admin });
    await expect(vote(session.id, state.current.ballot.id, admin2, 'YES'))
      .rejects.toMatchObject({ status: 403, code: 'OWN_RECORD' });
  });

  it('rejects anything but YES or NO', async () => {
    const { sessionId, state } = await activeSession();
    await expect(vote(sessionId, state.current.ballot.id, member, 'MAYBE')).rejects.toMatchObject({ status: 400 });
  });

  it('rolls back the version bump when a vote is refused', async () => {
    const { sessionId, state } = await activeSession();
    await closeBallot({ client: db, sessionId, ballotId: state.current.ballot.id, user: admin });
    const before = db.tables.liveVoteSession[0].version;
    await expect(vote(sessionId, state.current.ballot.id, member, 'YES')).rejects.toThrow();
    expect(db.tables.liveVoteSession[0].version).toBe(before);
  });
});

describe('running the session', () => {
  it('refuses a second close', async () => {
    const { sessionId, state } = await activeSession();
    await closeBallot({ client: db, sessionId, ballotId: state.current.ballot.id, user: admin });
    await expect(closeBallot({ client: db, sessionId, ballotId: state.current.ballot.id, user: admin2 }))
      .rejects.toMatchObject({ status: 409, code: 'BALLOT_NOT_OPEN' });
  });

  it('re-opens as a new round and keeps the earlier one as history', async () => {
    const { sessionId, state } = await activeSession();
    const { sessionCandidateId } = state.current;
    await vote(sessionId, state.current.ballot.id, member, 'YES');
    await closeBallot({ client: db, sessionId, ballotId: state.current.ballot.id, user: admin });

    const reopened = await reopenBallot({ client: db, sessionId, sessionCandidateId, user: admin });
    expect(reopened.current.ballot).toMatchObject({ status: 'OPEN', roundNumber: 2, votedCount: 0, myVote: null });
    expect(reopened.current.history).toMatchObject([{ roundNumber: 1, yesCount: 1, noCount: 0 }]);

    await expect(reopenBallot({ client: db, sessionId, sessionCandidateId, user: admin }))
      .rejects.toMatchObject({ status: 409, code: 'BALLOT_ALREADY_OPEN' });
  });

  it('moves on once when two admins press Next together, closing the open vote', async () => {
    const { sessionId, state } = await activeSession();
    await vote(sessionId, state.current.ballot.id, member, 'NO');

    const moved = await navigateSession({ client: db, sessionId, fromIndex: 0, toIndex: 1, user: admin });
    await expect(navigateSession({ client: db, sessionId, fromIndex: 0, toIndex: 1, user: admin2 }))
      .rejects.toMatchObject({ status: 409, code: 'STALE_INDEX' });

    expect(moved.current).toMatchObject({ position: 1, ballot: { status: 'OPEN', roundNumber: 1 } });
    expect(db.tables.liveVoteBallot[0]).toMatchObject({ status: 'CLOSED', noCount: 1 });
  });

  it('shows a result, not a fresh vote, when going back to a candidate already voted on', async () => {
    const { sessionId, state } = await activeSession();
    await vote(sessionId, state.current.ballot.id, member, 'YES');
    await navigateSession({ client: db, sessionId, fromIndex: 0, toIndex: 1, user: admin });
    const back = await navigateSession({ client: db, sessionId, fromIndex: 1, toIndex: 0, user: admin });
    expect(back.current.ballot).toMatchObject({ status: 'CLOSED', yesCount: 1 });
    expect(db.tables.liveVoteBallot.filter((row) => row.status === 'OPEN')).toHaveLength(0);
  });

  it('drops a ballot nobody voted on when moving past it, so it leaves no 0-0 result', async () => {
    const { sessionId } = await activeSession();
    await navigateSession({ client: db, sessionId, fromIndex: 0, toIndex: 1, user: admin });
    const second = db.tables.liveVoteSessionCandidate.find((row) => row.position === 1);
    expect(db.tables.liveVoteBallot.map((row) => row.sessionCandidateId)).toEqual([second.id]);

    // Coming back to it opens voting again rather than showing an empty result.
    const back = await navigateSession({ client: db, sessionId, fromIndex: 1, toIndex: 0, user: admin });
    expect(back.current.ballot).toMatchObject({ status: 'OPEN', roundNumber: 1 });
  });

  it('records an explicit close even with no votes', async () => {
    const { sessionId, state } = await activeSession();
    const closed = await closeBallot({ client: db, sessionId, ballotId: state.current.ballot.id, user: admin });
    expect(closed.current.ballot).toMatchObject({ status: 'CLOSED', yesCount: 0, noCount: 0 });
  });

  it('rejects a jump off the end of the list', async () => {
    const { sessionId } = await activeSession();
    await expect(navigateSession({ client: db, sessionId, fromIndex: 0, toIndex: 5, user: admin }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('applies a decision to the round column after voting closes, and records it on the ballot', async () => {
    const { sessionId, state } = await activeSession();
    const { sessionCandidateId } = state.current;

    await expect(applyDecision({ client: db, sessionId, sessionCandidateId, decision: 'yes', user: admin }))
      .rejects.toMatchObject({ status: 409, code: 'BALLOT_OPEN' });

    await closeBallot({ client: db, sessionId, ballotId: state.current.ballot.id, user: admin });
    const decided = await applyDecision({ client: db, sessionId, sessionCandidateId, decision: 'yes', user: admin });

    const application = await db.application.findFirst({ where: { id: 'app-1' } });
    expect(application).toMatchObject({ firstRoundDecision: 'yes', approved: true });
    expect(db.tables.comment).toMatchObject([{ applicationId: 'app-1', content: 'First Round decision: Yes - Advanced' }]);
    expect(decided.current).toMatchObject({ decision: 'yes', ballot: { decisionApplied: 'yes' } });
  });

  it('refuses decisions that are not Staging values', async () => {
    const { sessionId, state } = await activeSession();
    await expect(applyDecision({ client: db, sessionId, sessionCandidateId: state.current.sessionCandidateId, decision: 'strong_yes', user: admin }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('lets any admin end the session without joining, freezing an open vote', async () => {
    const { sessionId, state } = await activeSession({ joiners: [member] });
    await vote(sessionId, state.current.ballot.id, member, 'YES');

    const ended = await endSession({ client: db, sessionId, user: admin2 });
    expect(ended.session.status).toBe('ENDED');
    expect(db.tables.liveVoteBallot[0]).toMatchObject({ status: 'CLOSED', yesCount: 1 });
    await expect(endSession({ client: db, sessionId, user: admin })).rejects.toMatchObject({ code: 'SESSION_ENDED' });
    await expect(endSession({ client: db, sessionId, user: member })).rejects.toMatchObject({ status: 403 });

    // A new session can start once this one is over.
    await expect(launch(['app-1'])).resolves.toBeTruthy();
  });

  it('ends without recording the untouched ballot it was sitting on', async () => {
    const { sessionId } = await activeSession();
    await endSession({ client: db, sessionId, user: admin });
    expect(db.tables.liveVoteBallot).toHaveLength(0);
  });

  it('bumps the version exactly once per change', async () => {
    const { sessionId, state } = await activeSession();
    const before = db.tables.liveVoteSession[0].version;
    await vote(sessionId, state.current.ballot.id, member, 'YES');
    expect(db.tables.liveVoteSession[0].version).toBe(before + 1);
    await closeBallot({ client: db, sessionId, ballotId: state.current.ballot.id, user: admin });
    expect(db.tables.liveVoteSession[0].version).toBe(before + 2);
  });
});

describe('getActiveSession', () => {
  it('tells each user whether they have joined', async () => {
    expect(await getActiveSession({ client: db, user: member })).toEqual({ session: null });
    const { session } = await launch();
    expect((await getActiveSession({ client: db, user: admin })).session)
      .toMatchObject({ id: session.id, joined: true, candidateCount: 2, phaseLabel: 'First Round', createdByName: 'Ada Admin' });
    expect((await getActiveSession({ client: db, user: member })).session.joined).toBe(false);
  });
});

describe('normalizeCriteria', () => {
  it('trims, fills ids, and keeps given ids', () => {
    const [first, second] = normalizeCriteria([{ title: '  Drive ', description: ' Strong: ... ' }, { id: 'keep', title: 'Fit' }]);
    expect(first).toMatchObject({ title: 'Drive', description: 'Strong: ...' });
    expect(first.id).toBeTruthy();
    expect(second.id).toBe('keep');
  });

  it('rejects blank titles and oversized rubrics', () => {
    expect(() => normalizeCriteria([{ title: ' ' }])).toThrow(/title/);
    expect(() => normalizeCriteria(Array.from({ length: 21 }, () => ({ title: 'x' })))).toThrow(/at most 20/);
    expect(() => normalizeCriteria('nope')).toThrow();
  });
});
