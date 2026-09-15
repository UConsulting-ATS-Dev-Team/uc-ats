// What each viewer is allowed to learn from a live vote. The promises made to the
// room - counts stay hidden while voting is open, nobody can see who voted how,
// decisions are admin-only - are all enforced by buildState, so they are pinned
// here.
import { describe, it, expect } from 'vitest';
import { PRESENCE_WINDOW_MS, buildState, computeEligible, splitPercent } from './liveVoteState.js';

const NOW = Date.parse('2026-09-15T19:00:00Z');
const keyFor = (ballotId, userId) => `key:${ballotId}:${userId}`;

const admin = { id: 'u-admin', role: 'ADMIN', email: 'admin@ucla.edu', fullName: 'Ada Admin' };
const member = { id: 'u-member', role: 'MEMBER', email: 'mem@ucla.edu', fullName: 'Max Member' };
const candidateUser = { id: 'u-sam', role: 'MEMBER', email: 'sam@ucla.edu', studentId: '111', fullName: 'Sam Lee' };

const application = (overrides = {}) => ({
  id: 'app-1',
  firstName: 'Sam',
  lastName: 'Lee',
  email: 'sam@ucla.edu',
  studentId: '111',
  candidate: null,
  major1: 'Economics',
  graduationYear: '2028',
  headshotUrl: '/api/files/h1/image',
  resumeUrl: '/api/files/r1/view',
  firstRoundDecision: 'maybe_yes',
  ...overrides
});

const participant = (user, overrides = {}) => ({
  userId: user.id,
  lastSeenAt: new Date(NOW - 1000),
  leftAt: null,
  user,
  ...overrides
});

function raw({ ballots, openVotes = [], participants, sealed = [], status = 'ACTIVE' } = {}) {
  return {
    session: {
      id: 's1',
      phase: 'firstRound',
      status,
      currentIndex: 0,
      version: 7,
      rubric: [{ id: 'c1', title: 'Leadership', description: 'Strong: ...' }],
      startedAt: new Date(NOW - 60_000),
      endedAt: null,
      createdBy: { id: admin.id, fullName: admin.fullName }
    },
    candidates: [
      { id: 'sc1', position: 0, applicationId: 'app-1', application: application() },
      {
        id: 'sc2',
        position: 1,
        applicationId: 'app-2',
        application: application({ id: 'app-2', firstName: 'Kim', email: 'kim@ucla.edu', studentId: '222' })
      }
    ],
    participants: participants ?? [participant(admin), participant(member)],
    ballots: ballots ?? [{ id: 'b1', sessionCandidateId: 'sc1', roundNumber: 1, status: 'OPEN', openedAt: new Date(NOW) }],
    openVotes,
    sealedApplicationIds: new Set(sealed)
  };
}

const collectKeys = (value, keys = new Set()) => {
  if (Array.isArray(value)) value.forEach((item) => collectKeys(item, keys));
  else if (value && typeof value === 'object' && !(value instanceof Date)) {
    for (const [key, child] of Object.entries(value)) {
      keys.add(key);
      collectKeys(child, keys);
    }
  }
  return keys;
};

describe('buildState: open ballot', () => {
  const votes = [
    { voterKey: keyFor('b1', member.id), value: 'NO' },
    { voterKey: keyFor('b1', admin.id), value: 'YES' }
  ];

  it('reports how many have voted and never the split', () => {
    for (const viewer of [admin, member]) {
      const { current } = buildState(raw({ openVotes: votes }), { user: viewer, keyFor }, NOW);
      expect(current.ballot).toMatchObject({ status: 'OPEN', votedCount: 2, eligibleCount: 2 });
      expect(current.ballot).not.toHaveProperty('yesCount');
      expect(current.ballot).not.toHaveProperty('noCount');
      expect(current.ballot).not.toHaveProperty('yesPct');
    }
  });

  it("tells a viewer their own vote and nobody else's", () => {
    expect(buildState(raw({ openVotes: votes }), { user: member, keyFor }, NOW).current.ballot.myVote).toBe('NO');
    expect(buildState(raw({ openVotes: votes }), { user: admin, keyFor }, NOW).current.ballot.myVote).toBe('YES');
  });

  it('carries no voter identity anywhere in the payload', () => {
    const state = buildState(raw({ openVotes: votes }), { user: admin, keyFor }, NOW);
    const keys = [...collectKeys(state)];
    expect(keys.filter((key) => /voter(key|id|s)?$|^voters?/i.test(key))).toEqual([]);
    expect(keys).not.toContain('votes');
    expect(JSON.stringify(state)).not.toContain('key:b1');
  });

  it('stops a candidate voting on themselves and leaves them out of the eligible count', () => {
    const state = buildState(
      raw({ participants: [participant(admin), participant(member), participant(candidateUser)] }),
      { user: candidateUser, keyFor },
      NOW
    );
    expect(state.current.ballot).toMatchObject({ canVote: false, cannotVoteReason: 'OWN_RECORD', eligibleCount: 2 });
  });
});

describe('buildState: closed ballot', () => {
  const closed = [
    { id: 'b0', sessionCandidateId: 'sc1', roundNumber: 1, status: 'CLOSED', yesCount: 3, noCount: 5, eligibleCount: 9, decisionApplied: null, closedAt: new Date(NOW - 5000) },
    { id: 'b1', sessionCandidateId: 'sc1', roundNumber: 2, status: 'CLOSED', yesCount: 7, noCount: 2, eligibleCount: 9, decisionApplied: 'yes', closedAt: new Date(NOW) }
  ];

  it('reveals counts and percentages, with earlier rounds as history', () => {
    const { current } = buildState(raw({ ballots: closed }), { user: member, keyFor }, NOW);
    expect(current.ballot).toMatchObject({ status: 'CLOSED', roundNumber: 2, yesCount: 7, noCount: 2, yesPct: 78, noPct: 22 });
    expect(current.history).toHaveLength(1);
    expect(current.history[0]).toMatchObject({ roundNumber: 1, yesCount: 3, noCount: 5 });
  });

  it('keeps the Staging decision from members', () => {
    const forMember = buildState(raw({ ballots: closed }), { user: member, keyFor }, NOW);
    expect(forMember.current).not.toHaveProperty('decision');
    expect(forMember.current.ballot).not.toHaveProperty('decisionApplied');
    expect(forMember.roster[0]).not.toHaveProperty('decision');

    const forAdmin = buildState(raw({ ballots: closed }), { user: admin, keyFor }, NOW);
    expect(forAdmin.current.decision).toBe('maybe_yes');
    expect(forAdmin.current.ballot.decisionApplied).toBe('yes');
    expect(forAdmin.roster[0]).toMatchObject({ decisionApplied: 'yes', latest: { yesCount: 7, noCount: 2 }, rounds: 2 });
  });
});

describe('buildState: people and records', () => {
  it('counts only participants seen recently who have not left', () => {
    const state = buildState(
      raw({
        participants: [
          participant(admin),
          participant(member, { lastSeenAt: new Date(NOW - PRESENCE_WINDOW_MS - 1) }),
          participant(candidateUser, { leftAt: new Date(NOW - 10) })
        ]
      }),
      { user: admin, keyFor },
      NOW
    );
    expect(state.participants.presentCount).toBe(1);
    expect(state.participants.people).toEqual([{ id: admin.id, fullName: admin.fullName }]);
  });

  it('marks only a joined admin as host, and never once the session has ended', () => {
    expect(buildState(raw(), { user: admin, keyFor }, NOW).me).toMatchObject({ isHost: true, joined: true });
    expect(buildState(raw(), { user: member, keyFor }, NOW).me).toMatchObject({ isHost: false, joined: true });
    expect(buildState(raw({ status: 'ENDED' }), { user: admin, keyFor }, NOW).me.isHost).toBe(false);
  });

  it('shows a sealed candidate by name only', () => {
    const { candidate } = buildState(raw({ sealed: ['app-1'] }), { user: admin, keyFor }, NOW).current;
    expect(candidate).toMatchObject({ name: 'Sam Lee', locked: true, major: null, graduationYear: null, resumeUrl: null });
  });

  it('shows no current candidate in the lobby', () => {
    expect(buildState(raw({ status: 'LOBBY', ballots: [] }), { user: member, keyFor }, NOW).current).toBeNull();
  });
});

describe('computeEligible', () => {
  it('still counts someone who voted and then dropped off', () => {
    const votes = [{ voterKey: keyFor('b1', 'gone'), value: 'YES' }];
    const present = [participant(admin), participant(member)];
    expect(computeEligible({ present, votes, ballotId: 'b1', application: application(), keyFor })).toBe(3);
  });

  it('does not double count a present voter', () => {
    const votes = [{ voterKey: keyFor('b1', admin.id), value: 'YES' }];
    expect(computeEligible({ present: [participant(admin)], votes, ballotId: 'b1', application: application(), keyFor })).toBe(1);
  });
});

describe('splitPercent', () => {
  it('is 0/0 with no votes rather than NaN', () => {
    expect(splitPercent(0, 0)).toEqual({ yesPct: 0, noPct: 0 });
  });

  it('always adds to 100', () => {
    expect(splitPercent(1, 2)).toEqual({ yesPct: 33, noPct: 67 });
  });
});
