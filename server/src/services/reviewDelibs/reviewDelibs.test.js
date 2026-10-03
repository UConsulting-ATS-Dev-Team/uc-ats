// The review team deliberation, run against an in-memory database. What matters:
// only the team and admins can watch, one session per team (teams in parallel),
// stale navigation is refused rather than applied twice, an override writes only
// adminScore and is logged, a decision lands where Staging's picker writes it,
// and sealed or own records are never touched.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  clearCaches,
  endSession,
  getActiveSessions,
  getCandidateCard,
  getChanges,
  getGroupStatuses,
  getState,
  getTeamView,
  joinSession,
  launchSession,
  navigate,
  overrideScore,
  setDecision,
  setThreshold
} from './reviewDelibs.js';
import { loadTeamInput } from './teamData.js';
import { loadParticipationPoints } from '../applicationParticipation.js';
import { normalizeRow } from './teamStats.js';
import { nudgeReviewDelib, nudgeReviewDelibsGlobal } from '../realtime.js';

vi.mock('../../prismaClient.js', () => ({ default: {} }));
vi.mock('../realtime.js', () => ({ nudgeReviewDelib: vi.fn(), nudgeReviewDelibsGlobal: vi.fn() }));
vi.mock('./teamData.js', async (importOriginal) => ({ ...(await importOriginal()), loadTeamInput: vi.fn() }));

// ---------------------------------------------------------------------------
// A small in-memory Prisma: only the calls this service makes.
// ---------------------------------------------------------------------------

let seq = 0;
const uid = (prefix) => `${prefix}-${++seq}`;

const isPlainObject = (value) => value && typeof value === 'object' && !(value instanceof Date) && !Array.isArray(value);

const matchValue = (actual, expected) => {
  if (isPlainObject(expected)) {
    if ('in' in expected) return expected.in.includes(actual);
    if ('not' in expected) return expected.not === null ? actual != null : actual !== expected.not;
    return matches(actual || {}, expected);
  }
  return actual === expected;
};

function matches(row, where = {}) {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR') return expected.some((clause) => matches(row, clause));
    if (key.includes('_') && isPlainObject(expected)) return matches(row, expected); // compound unique
    return matchValue(row[key], expected);
  });
}

const SCORE_TABLES = { resume: 'resumeScore', coverLetter: 'coverLetterScore', video: 'videoScore' };

function fakeDb() {
  const users = [
    { id: 'admin1', role: 'ADMIN', fullName: 'Ada Admin', email: 'ada@uc.org' },
    { id: 'admin2', role: 'ADMIN', fullName: 'Bo Admin', email: 'bo@ucla.edu', studentId: '222' },
    { id: 'm1', role: 'MEMBER', fullName: 'Mia Member', email: 'mia@ucla.edu' },
    { id: 'm2', role: 'MEMBER', fullName: 'Max Member', email: 'max@ucla.edu' },
    { id: 'm3', role: 'MEMBER', fullName: 'Other Team', email: 'other@ucla.edu' },
    { id: 'talent', role: 'MEMBER', fullName: 'Talent', isExternalTalent: true }
  ];
  const groups = [
    { id: 'g1', cycleId: 'cycle-1', name: 'Team Alpha', memberOne: 'm1', memberTwo: 'm2', memberThree: null, groupMembers: [], createdAt: new Date(1) },
    { id: 'g2', cycleId: 'cycle-1', name: 'Team Beta', memberOne: 'm3', memberTwo: null, memberThree: null, groupMembers: [], createdAt: new Date(2) },
    { id: 'g-old', cycleId: 'cycle-0', name: 'Old Team', memberOne: 'm1', memberTwo: null, memberThree: null, groupMembers: [], createdAt: new Date(0) }
  ];
  const candidates = [
    { id: 'c1', assignedGroupId: 'g1', recordsLockedAt: null, email: 'c1@ucla.edu', studentId: '1' },
    { id: 'c2', assignedGroupId: 'g1', recordsLockedAt: null, email: 'bo@ucla.edu', studentId: '222' }, // admin2's own
    { id: 'c3', assignedGroupId: 'g1', recordsLockedAt: new Date(), email: 'c3@ucla.edu', studentId: '3' },
    { id: 'c4', assignedGroupId: 'g2', recordsLockedAt: null, email: 'c4@ucla.edu', studentId: '4' },
    { id: 'c5', assignedGroupId: 'g1', recordsLockedAt: null, email: 'c5@ucla.edu', studentId: '5' }
  ];
  const app = (n, candidateId, extra = {}) => {
    const candidate = candidates.find((row) => row.id === candidateId);
    return {
      id: `app${n}`, candidateId, cycleId: 'cycle-1', firstName: `Cand`, lastName: `${n}`,
      email: candidate.email, studentId: candidate.studentId, major1: 'Econ', graduationYear: '2027',
      cumulativeGpa: '3.80', headshotUrl: null, resumeUrl: `/api/files/r${n}/pdf`, coverLetterUrl: null,
      shortAnswer: null, videoUrl: null, resumeDecision: null, submittedAt: new Date(),
      get candidate() { return candidate; },
      ...extra
    };
  };
  const applications = [app(1, 'c1'), app(2, 'c2'), app(3, 'c3'), app(4, 'c4'), app(5, 'c5')];

  const score = (candidateId, evaluatorId, overallScore) =>
    ({ id: uid('rs'), candidateId, evaluatorId, overallScore, adminScore: null, cycleId: 'cycle-1', scoreOne: null, scoreTwo: null, scoreThree: null });
  const tables = {
    reviewDelibSession: [],
    reviewDelibParticipant: [],
    reviewDelibChange: [],
    comment: [],
    resumeScore: [
      score('c1', 'm1', 2), score('c1', 'm2', 10), score('c1', 'admin1', 10), // m1 is the outlier
      score('c2', 'm1', 6), score('c2', 'm2', 12), // a split
      score('c3', 'm1', 1), score('c3', 'm2', 13), // sealed
      score('c4', 'm3', 9),
      score('c5', 'm1', 4), score('c5', 'm2', 6), score('c5', 'admin1', 6) // only an outlier at a low threshold
    ],
    coverLetterScore: [],
    videoScore: [],
    // What Application Detail shows besides grades, for the card.
    events: [
      { id: 'e1', cycleId: 'cycle-1', eventName: 'Info Sesh', eventStartDate: new Date('2026-09-20'), eventEndDate: null, eventLocation: 'Ackerman' },
      { id: 'e2', cycleId: 'cycle-1', eventName: 'Case Workshop', eventStartDate: new Date('2026-09-25'), eventEndDate: null, eventLocation: 'Bunche' },
      { id: 'e-old', cycleId: 'cycle-0', eventName: 'Last Year', eventStartDate: new Date('2025-09-20'), eventEndDate: null, eventLocation: null }
    ],
    eventRsvp: [{ candidateId: 'c1', eventId: 'e1' }, { candidateId: 'c1', eventId: 'e2' }],
    eventAttendance: [
      { candidateId: 'c1', eventId: 'e1', event: { cycleId: 'cycle-1' } },
      { candidateId: 'c5', eventId: 'e-old', event: { cycleId: 'cycle-0' } }
    ],
    meetingSignup: [{
      id: 'signup-1', studentId: '1', attended: true,
      slot: { startTime: new Date('2026-09-22T17:00:00Z'), endTime: new Date('2026-09-22T17:30:00Z'), location: 'Kerckhoff', member: { fullName: 'Mia Member' } }
    }],
    referral: [
      { id: 'r2', candidateId: 'c1', cycleId: 'cycle-1', source: 'PRE_APPLICATION', referrerName: 'Mia', relationship: 'Roommate', reason: 'Sharp and kind', referredByUserId: 'm1', createdAt: new Date(2) },
      { id: 'r1', candidateId: 'c1', cycleId: 'cycle-1', source: 'MANUAL', referrerName: 'Pat Alum', relationship: 'Classmate', reason: null, referredByUserId: null, createdAt: new Date(1) },
      { id: 'r-old', candidateId: 'c1', cycleId: 'cycle-0', source: 'MANUAL', referrerName: 'Old', relationship: 'Old', reason: null, referredByUserId: null, createdAt: new Date(0) }
    ]
  };

  const find = (table, where) => tables[table].find((row) => matches(row, where)) || null;
  const filter = (table, where) => tables[table].filter((row) => matches(row, where));
  const userById = (id) => users.find((user) => user.id === id) || null;
  const groupById = (id) => groups.find((group) => group.id === id) || null;
  const withMembers = (group) => group && {
    ...group,
    memberOneUser: userById(group.memberOne),
    memberTwoUser: userById(group.memberTwo),
    memberThreeUser: userById(group.memberThree)
  };

  const genericUpdate = (table) => async ({ where, data }) => {
    const row = find(table, where);
    if (!row) throw Object.assign(new Error('not found'), { code: 'P2025' });
    for (const [key, value] of Object.entries(data)) {
      row[key] = isPlainObject(value) && 'increment' in value ? row[key] + value.increment : value;
    }
    return { ...row };
  };

  const sessionView = (session, include) => {
    if (!include) return { ...session };
    return {
      ...session,
      group: withMembers(groupById(session.groupId)),
      createdBy: userById(session.createdById),
      participants: filter('reviewDelibParticipant', { sessionId: session.id, ...(include.participants?.where || {}) })
        .map((row) => ({ ...row, user: userById(row.userId) })),
      _count: { changes: filter('reviewDelibChange', { sessionId: session.id }).length }
    };
  };

  const scoreTable = (table) => ({
    findUnique: vi.fn(async ({ where }) => {
      const row = find(table, where);
      return row && { ...row, evaluator: userById(row.evaluatorId) };
    }),
    update: vi.fn(genericUpdate(table))
  });

  const client = {
    tables,
    users,
    groupRows: groups,
    applications,
    candidates,
    $transaction: async (fn) => fn(client),
    recruitingCycle: {
      findFirst: vi.fn(async () => ({ id: 'cycle-1', isActive: true, isAdminActive: true })),
      findUnique: vi.fn(async () => ({ startDate: new Date('2026-09-01'), endDate: new Date('2026-12-15') }))
    },
    events: { findMany: vi.fn(async ({ where }) => filter('events', where)) },
    eventRsvp: { findMany: vi.fn(async ({ where }) => filter('eventRsvp', where)) },
    eventAttendance: { findMany: vi.fn(async ({ where }) => filter('eventAttendance', where)) },
    // Only the fields this service asks on; the date window is the service's own test.
    meetingSignup: {
      findFirst: vi.fn(async ({ where }) => find('meetingSignup', { studentId: where.studentId, attended: where.attended })),
      // Staging's bulk read, date window and all.
      findMany: vi.fn(async ({ where }) => tables.meetingSignup.filter((row) => where.studentId.in.includes(row.studentId) &&
        row.attended === where.attended &&
        row.slot.startTime >= where.slot.startTime.gte &&
        (!where.slot.startTime.lte || row.slot.startTime <= where.slot.startTime.lte)))
    },
    referral: {
      findMany: vi.fn(async ({ where }) => filter('referral', where)
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((row) => ({ ...row, referredBy: row.referredByUserId ? userById(row.referredByUserId) : null })))
    },
    documentRubric: { findMany: vi.fn(async () => []) },
    groups: { findUnique: vi.fn(async ({ where }) => groupById(where.id)) },
    candidate: { findMany: vi.fn(async ({ where }) => candidates.filter((row) => matches(row, where))) },
    user: { findMany: vi.fn(async ({ where }) => users.filter((row) => matches(row, where))) },
    comment: { create: vi.fn(async ({ data }) => tables.comment.push({ ...data })) },
    application: {
      findMany: vi.fn(async ({ where }) => applications.filter((row) => matches(row, where))),
      findFirst: vi.fn(async ({ where }) => applications.find((row) => matches(row, where)) || null),
      update: vi.fn(async ({ where, data }) => {
        const row = applications.find((entry) => entry.id === where.id);
        const { comments, ...fields } = data;
        Object.assign(row, fields);
        if (comments?.create) tables.comment.push({ applicationId: row.id, ...comments.create });
        return { ...row };
      })
    },
    resumeScore: scoreTable('resumeScore'),
    coverLetterScore: scoreTable('coverLetterScore'),
    videoScore: scoreTable('videoScore'),
    reviewDelibSession: {
      create: vi.fn(async ({ data }) => {
        if (tables.reviewDelibSession.some((row) => row.groupId === data.groupId && row.status === 'ACTIVE')) {
          throw Object.assign(new Error('unique'), { code: 'P2002' });
        }
        const { participants, ...fields } = data;
        const session = {
          id: uid('session'), status: 'ACTIVE', step: 'OVERVIEW', currentApplicationId: null, version: 0,
          startedAt: new Date(), endedAt: null, ...fields
        };
        tables.reviewDelibSession.push(session);
        tables.reviewDelibParticipant.push({ id: uid('p'), sessionId: session.id, joinedAt: new Date(), lastSeenAt: new Date(), leftAt: null, ...participants.create });
        return { id: session.id, status: session.status };
      }),
      update: vi.fn(genericUpdate('reviewDelibSession')),
      findUnique: vi.fn(async ({ where, include }) => {
        const session = find('reviewDelibSession', where);
        return session ? sessionView(session, include) : null;
      }),
      findFirst: vi.fn(async ({ where }) => find('reviewDelibSession', where)),
      findMany: vi.fn(async ({ where, include }) => filter('reviewDelibSession', where).map((session) => ({
        ...sessionView(session, include),
        _count: { changes: filter('reviewDelibChange', { sessionId: session.id }).length }
      })))
    },
    reviewDelibParticipant: {
      findUnique: vi.fn(async ({ where }) => find('reviewDelibParticipant', where.sessionId_userId)),
      findMany: vi.fn(async ({ where }) => filter('reviewDelibParticipant', where)),
      update: vi.fn(genericUpdate('reviewDelibParticipant')),
      updateMany: vi.fn(async ({ where, data }) => {
        const rows = filter('reviewDelibParticipant', where);
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      }),
      upsert: vi.fn(async ({ where, create, update }) => {
        const row = find('reviewDelibParticipant', where.sessionId_userId);
        if (row) Object.assign(row, update);
        else tables.reviewDelibParticipant.push({ id: uid('p'), joinedAt: new Date(), lastSeenAt: new Date(), leftAt: null, ...create });
      })
    },
    reviewDelibChange: {
      create: vi.fn(async ({ data }) => tables.reviewDelibChange.push({ id: uid('change'), createdAt: new Date(Date.now() + seq), ...data })),
      findMany: vi.fn(async ({ where }) => filter('reviewDelibChange', where))
    }
  };
  return client;
}

// What teamData.js would read, built from the fake tables so overrides show up.
function inputFrom(db) {
  return async ({ groupId, cycleId, participation = true }) => {
    const groups = db.groupRows.filter((group) => group.cycleId === cycleId);
    const candidates = db.applications
      .filter((application) => groups.some((group) => group.id === application.candidate.assignedGroupId))
      .map((application) => ({
        candidateId: application.candidateId,
        applicationId: application.id,
        groupId: application.candidate.assignedGroupId,
        name: `${application.firstName} ${application.lastName}`,
        hasDoc: { resume: true, coverLetter: false, video: false },
        resumeDecision: application.resumeDecision,
        locked: Boolean(application.candidate.recordsLockedAt),
        application
      }));
    const sealed = new Set(candidates.filter((entry) => entry.locked).map((entry) => entry.candidateId));
    const open = candidates.filter((entry) => !entry.locked);
    const points = participation && await loadParticipationPoints({
      client: db,
      cycleId,
      candidates: open.map((entry) => ({ candidateId: entry.candidateId, studentId: entry.application.studentId }))
    });
    if (points) for (const entry of open) entry.participationPoints = points.get(entry.candidateId);
    const rows = db.tables.resumeScore
      .filter((row) => !sealed.has(row.candidateId))
      .map((row) => normalizeRow({ ...row, evaluator: db.users.find((user) => user.id === row.evaluatorId) }, 'resume'));
    const user = (id) => db.users.find((entry) => entry.id === id);
    return {
      groupId,
      group: { id: groupId, name: groups.find((group) => group.id === groupId)?.name },
      groups: groups.map((group) => ({
        id: group.id,
        name: group.name,
        members: [group.memberOne, group.memberTwo, group.memberThree].filter(Boolean).map((id) => ({ id, name: user(id).fullName }))
      })),
      candidates,
      rows,
      maxByType: { resume: 13, coverLetter: 3, video: 2 },
      participationMax: 3,
      rubrics: { resume: { rubric: { categories: [] } }, coverLetter: { rubric: { categories: [] } }, video: { rubric: { categories: [] } } }
    };
  };
}

let db;
const as = (id) => db.users.find((user) => user.id === id);

async function launched(groupId = 'g1', extra = {}) {
  const { session } = await launchSession({ client: db, user: as('admin1'), groupId, ...extra });
  return session.id;
}

const rejects = (promise, status, code) => expect(promise).rejects.toMatchObject({ status, code });

beforeEach(() => {
  db = fakeDb();
  clearCaches();
  vi.mocked(loadTeamInput).mockImplementation(inputFrom(db));
  vi.mocked(nudgeReviewDelib).mockClear();
  vi.mocked(nudgeReviewDelibsGlobal).mockClear();
});

describe('launchSession', () => {
  it('snapshots the walkthrough, widest disagreement first, and announces the session', async () => {
    const sessionId = await launched();
    const session = db.tables.reviewDelibSession.find((row) => row.id === sessionId);

    expect(session.outlierApplicationIds).toEqual(['app1', 'app2']);
    expect(session.cycleId).toBe('cycle-1');
    expect(db.tables.reviewDelibParticipant).toMatchObject([{ sessionId, userId: 'admin1' }]);
    expect(nudgeReviewDelibsGlobal).toHaveBeenCalledWith({ sessionId, status: 'ACTIVE' });
  });

  it('is admin only', async () => {
    await rejects(launchSession({ client: db, user: as('m1'), groupId: 'g1' }), 403, 'FORBIDDEN');
  });

  it('refuses a second session for the same team, pointing at the first', async () => {
    const first = await launched();
    await expect(launchSession({ client: db, user: as('admin2'), groupId: 'g1' }))
      .rejects.toMatchObject({ status: 409, code: 'DELIB_ACTIVE', sessionId: first });
  });

  it('lets two teams run at once', async () => {
    await launched('g1');
    await expect(launched('g2')).resolves.toBeTruthy();
  });

  it('refuses a team from another cycle and a threshold out of range', async () => {
    await rejects(launchSession({ client: db, user: as('admin1'), groupId: 'g-old' }), 409, 'GROUP_NOT_IN_CYCLE');
    await rejects(launchSession({ client: db, user: as('admin1'), groupId: 'g1', thresholdPct: 0.9 }), 400, 'INVALID_THRESHOLD');
  });
});

describe('who can watch', () => {
  it('lets the team in and keeps other members out', async () => {
    const sessionId = await launched();
    const state = await joinSession({ client: db, sessionId, user: as('m1') });
    expect(state.session.groupName).toBe('Team Alpha');
    expect(state.viewer).toMatchObject({ isAdmin: false, isHost: false });

    await expect(joinSession({ client: db, sessionId, user: as('m3') }))
      .rejects.toMatchObject({ status: 403, code: 'NOT_ON_TEAM', groupName: 'Team Alpha' });
    await rejects(joinSession({ client: db, sessionId, user: as('talent') }), 403, 'NOT_ON_TEAM');
  });

  it('requires joining before reading', async () => {
    const sessionId = await launched();
    await rejects(getState({ client: db, sessionId, user: as('m2') }), 403, 'NOT_JOINED');
    await rejects(getTeamView({ client: db, sessionId, user: as('m2') }), 403, 'NOT_JOINED');
  });

  it('cuts off a member moved off the team mid-session', async () => {
    const sessionId = await launched();
    await joinSession({ client: db, sessionId, user: as('m1') });
    db.groupRows.find((group) => group.id === 'g1').memberOne = null;
    clearCaches();
    await rejects(getState({ client: db, sessionId, user: as('m1') }), 403, 'NOT_ON_TEAM');
  });

  it('cuts off a removed member at once, even with their state cached', async () => {
    const sessionId = await launched();
    await joinSession({ client: db, sessionId, user: as('m1') });
    await getState({ client: db, sessionId, user: as('m1') }); // the state read is cached for a second
    db.groupRows.find((group) => group.id === 'g1').memberOne = null;
    await rejects(getState({ client: db, sessionId, user: as('m1') }), 403, 'NOT_ON_TEAM');
  });

  it('shows each person only the sessions they may join', async () => {
    await launched('g1');
    await launched('g2');
    expect((await getActiveSessions({ client: db, user: as('m1') })).sessions.map((entry) => entry.groupName)).toEqual(['Team Alpha']);
    expect((await getActiveSessions({ client: db, user: as('m3') })).sessions.map((entry) => entry.groupName)).toEqual(['Team Beta']);
    expect((await getActiveSessions({ client: db, user: as('admin2') })).sessions).toHaveLength(2);
  });

  it('lists the team members who have not joined', async () => {
    const sessionId = await launched();
    const state = await getState({ client: db, sessionId, user: as('admin1') });
    expect(state.participants.filter((entry) => !entry.present).map((entry) => entry.userId)).toEqual(['m1', 'm2']);
  });
});

describe('navigate', () => {
  it('needs an admin who has joined', async () => {
    const sessionId = await launched();
    await joinSession({ client: db, sessionId, user: as('m1') });
    await rejects(navigate({ client: db, sessionId, user: as('m1'), step: 'OUTLIERS' }), 403, 'FORBIDDEN');
    await rejects(navigate({ client: db, sessionId, user: as('admin2'), step: 'OUTLIERS' }), 403, 'JOIN_REQUIRED');
  });

  it('opens the first outlier and moves everyone with it', async () => {
    const sessionId = await launched();
    const state = await navigate({ client: db, sessionId, user: as('admin1'), step: 'OUTLIERS', from: { step: 'OVERVIEW', applicationId: null } });
    expect(state.session).toMatchObject({ step: 'OUTLIERS', currentApplicationId: 'app1' });
    expect(nudgeReviewDelib).toHaveBeenCalledWith(sessionId, expect.objectContaining({ kind: 'control' }));
  });

  it('refuses a move made from a screen someone already changed', async () => {
    const sessionId = await launched();
    await navigate({ client: db, sessionId, user: as('admin1'), step: 'OUTLIERS', from: { step: 'OVERVIEW', applicationId: null } });
    await rejects(
      navigate({ client: db, sessionId, user: as('admin1'), step: 'ALL', from: { step: 'OVERVIEW', applicationId: null } }),
      409, 'STALE_NAV'
    );
  });

  it('only opens candidates on this team, and only walkthrough ones in the walkthrough', async () => {
    const sessionId = await launched();
    await rejects(navigate({ client: db, sessionId, user: as('admin1'), step: 'ALL', applicationId: 'app4' }), 404, 'NOT_ON_TEAM_LIST');
    await rejects(navigate({ client: db, sessionId, user: as('admin1'), step: 'ALL', applicationId: 'app3' }), 423, 'RECORD_LOCKED');
    await rejects(navigate({ client: db, sessionId, user: as('admin1'), step: 'OUTLIERS', applicationId: 'app5' }), 400, 'NOT_IN_WALKTHROUGH');
    const state = await navigate({ client: db, sessionId, user: as('admin1'), step: 'ALL', applicationId: 'app5' });
    expect(state.session.currentApplicationId).toBe('app5');
  });
});

describe('a walkthrough candidate sealed mid-session', () => {
  const seal = (candidateId) => { db.candidates.find((row) => row.id === candidateId).recordsLockedAt = new Date(); };

  it('opens Outliers on the first one still available', async () => {
    const sessionId = await launched();
    seal('c1');
    const state = await navigate({ client: db, sessionId, user: as('admin1'), step: 'OUTLIERS' });
    expect(state.session.currentApplicationId).toBe('app2');
  });

  it('is skipped by Next instead of blocking it', async () => {
    const sessionId = await launched();
    await setThreshold({ client: db, sessionId, user: as('admin1'), thresholdPct: 0.1 }); // app1, app2, app5
    await navigate({ client: db, sessionId, user: as('admin1'), step: 'OUTLIERS' });
    seal('c2');
    const state = await navigate({ client: db, sessionId, user: as('admin1'), step: 'OUTLIERS', applicationId: 'app2' });
    expect(state.session.currentApplicationId).toBe('app5');
  });

  it('drops to a name in the team view at once, cache or no cache', async () => {
    const sessionId = await launched();
    const before = await getTeamView({ client: db, sessionId, user: as('admin1') }); // warms the team cache
    expect(before.candidates.find((row) => row.applicationId === 'app1').locked).toBe(false);
    seal('c1');
    const after = await getTeamView({ client: db, sessionId, user: as('admin1') });
    expect(Object.keys(after.candidates.find((row) => row.applicationId === 'app1')).sort())
      .toEqual(['applicationId', 'candidateId', 'locked', 'name']);
  });

  it('stops being served on its card at once, cache or no cache', async () => {
    const sessionId = await launched();
    await getCandidateCard({ client: db, sessionId, applicationId: 'app1', user: as('admin1') }); // warms the team cache
    seal('c1');
    await rejects(getCandidateCard({ client: db, sessionId, applicationId: 'app1', user: as('admin1') }), 423, 'RECORD_LOCKED');
  });
});

describe('setThreshold', () => {
  const scoreOf = (candidateId, evaluatorId) =>
    db.tables.resumeScore.find((row) => row.candidateId === candidateId && row.evaluatorId === evaluatorId);
  const threshold = (sessionId, thresholdPct) => setThreshold({ client: db, sessionId, user: as('admin1'), thresholdPct });

  it('adds newly qualifying candidates to the end of the walkthrough when lowered', async () => {
    const sessionId = await launched();
    const state = await threshold(sessionId, 0.1);
    expect(state.session.thresholdPct).toBe(0.1);
    expect(state.session.outlierApplicationIds).toEqual(['app1', 'app2', 'app5']);
  });

  it('drops candidates who no longer qualify when raised, keeping the order of the rest', async () => {
    const sessionId = await launched('g1', { thresholdPct: 0.1 }); // app1, app2, app5
    // app2's split widens past app1's outlier, so a fresh order would put app2 first.
    scoreOf('c2', 'm1').overallScore = 0;
    let state = await threshold(sessionId, 0.2);
    expect(state.session.outlierApplicationIds).toEqual(['app1', 'app2']);

    state = await threshold(sessionId, 0.6);
    expect(state.session.outlierApplicationIds).toEqual(['app1', 'app2']); // 12 apart is still a split at 7.8
    scoreOf('c2', 'm1').overallScore = 6;
    state = await threshold(sessionId, 0.5);
    expect(state.session.outlierApplicationIds).toEqual(['app1']);
  });

  it('keeps a candidate whose outlier the room resolved with an override', async () => {
    const sessionId = await launched(); // app1, app2
    await overrideScore({ client: db, sessionId, user: as('admin1'), type: 'resume', scoreId: scoreOf('c1', 'm1').id, adminScore: 10 });
    const state = await threshold(sessionId, 0.5);
    expect(state.session.outlierApplicationIds).toEqual(['app1']);
  });

  it('moves the room off a candidate the walkthrough just dropped, only on the Outliers step', async () => {
    const sessionId = await launched(); // app1, app2
    await navigate({ client: db, sessionId, user: as('admin1'), step: 'OUTLIERS', applicationId: 'app2' });
    let state = await threshold(sessionId, 0.5);
    expect(state.session).toMatchObject({ outlierApplicationIds: ['app1'], currentApplicationId: 'app1' });

    await threshold(sessionId, 0.3);
    await navigate({ client: db, sessionId, user: as('admin1'), step: 'ALL', applicationId: 'app2' });
    state = await threshold(sessionId, 0.5);
    expect(state.session).toMatchObject({ step: 'ALL', currentApplicationId: 'app2' });
  });

  it('empties the walkthrough, and the screen, when nothing qualifies', async () => {
    const sessionId = await launched();
    await navigate({ client: db, sessionId, user: as('admin1'), step: 'OUTLIERS' });
    for (const row of db.tables.resumeScore) row.overallScore = 6;
    const state = await threshold(sessionId, 0.3);
    expect(state.session).toMatchObject({ outlierApplicationIds: [], currentApplicationId: null });
  });
});

describe('overrideScore', () => {
  const scoreOf = (candidateId, evaluatorId) =>
    db.tables.resumeScore.find((row) => row.candidateId === candidateId && row.evaluatorId === evaluatorId);

  it('writes only the override, logs it, and leaves the grade as graded', async () => {
    const sessionId = await launched();
    const target = scoreOf('c1', 'm1');
    const before = db.tables.reviewDelibSession[0].version;

    await overrideScore({ client: db, sessionId, user: as('admin1'), type: 'resume', scoreId: target.id, adminScore: 9 });

    expect(target).toMatchObject({ adminScore: 9, overallScore: 2 });
    expect(db.tables.reviewDelibChange).toMatchObject([
      { kind: 'SCORE', scoreId: target.id, fromValue: null, toValue: '9', originalScore: 2, applicationId: 'app1' }
    ]);
    expect(db.tables.comment.at(-1).content).toBe("Review team deliberation: Mia Member's resume score overridden 2 → 9 (graded 2)");
    expect(db.tables.reviewDelibSession[0].version).toBeGreaterThan(before);
  });

  it('resolves the outlier in the team view', async () => {
    const sessionId = await launched();
    await overrideScore({ client: db, sessionId, user: as('admin1'), type: 'resume', scoreId: scoreOf('c1', 'm1').id, adminScore: 10 });
    const card = await getCandidateCard({ client: db, sessionId, applicationId: 'app1', user: as('admin1') });
    const row = card.docs.resume.rows.find((entry) => entry.evaluatorId === 'm1');
    expect(row).toMatchObject({ effective: 10, overall: 2, isOutlier: false, rawFlag: 'outlier', onTeam: true });
  });

  it('clears an override with null', async () => {
    const sessionId = await launched();
    const target = scoreOf('c1', 'm1');
    await overrideScore({ client: db, sessionId, user: as('admin1'), type: 'resume', scoreId: target.id, adminScore: 9 });
    await overrideScore({ client: db, sessionId, user: as('admin1'), type: 'resume', scoreId: target.id, adminScore: null });
    expect(target.adminScore).toBe(null);
    expect(db.tables.comment.at(-1).content).toContain('cleared the override');
  });

  it('records nothing when the value does not change', async () => {
    const sessionId = await launched();
    await overrideScore({ client: db, sessionId, user: as('admin1'), type: 'resume', scoreId: scoreOf('c1', 'm1').id, adminScore: null });
    expect(db.tables.reviewDelibChange).toHaveLength(0);
  });

  it('refuses out-of-range, sealed, own and other-team scores', async () => {
    const sessionId = await launched();
    await joinSession({ client: db, sessionId, user: as('admin2') });
    const call = (user, candidateId, evaluatorId, adminScore = 5) =>
      overrideScore({ client: db, sessionId, user: as(user), type: 'resume', scoreId: scoreOf(candidateId, evaluatorId).id, adminScore });

    await rejects(call('admin1', 'c1', 'm1', 20), 400, 'SCORE_OUT_OF_RANGE');
    await rejects(call('admin1', 'c3', 'm1'), 423, 'RECORD_LOCKED');
    await rejects(call('admin2', 'c2', 'm1'), 403, 'OWN_RECORD');
    await rejects(call('admin1', 'c4', 'm3'), 404, 'NOT_ON_TEAM_LIST');
    await rejects(overrideScore({ client: db, sessionId, user: as('admin1'), type: 'essay', scoreId: 'x' }), 400, 'INVALID_TYPE');
    expect(db.tables.reviewDelibChange).toHaveLength(0);
  });
});

describe('setDecision', () => {
  it("writes Staging's Resume Review decision and logs the change", async () => {
    const sessionId = await launched();
    await setDecision({ client: db, sessionId, user: as('admin1'), applicationId: 'app1', decision: 'yes' });

    const application = db.applications.find((row) => row.id === 'app1');
    expect(application).toMatchObject({ resumeDecision: 'yes', approved: true });
    expect(db.tables.comment.at(-1).content).toBe('Resume Review decision: Yes - Advanced');
    expect(db.tables.reviewDelibChange).toMatchObject([{ kind: 'DECISION', fromValue: null, toValue: 'yes' }]);
  });

  it('refuses unknown decisions and sealed or own records', async () => {
    const sessionId = await launched();
    await joinSession({ client: db, sessionId, user: as('admin2') });
    await rejects(setDecision({ client: db, sessionId, user: as('admin1'), applicationId: 'app1', decision: 'perhaps' }), 400, 'INVALID_DECISION');
    await rejects(setDecision({ client: db, sessionId, user: as('admin1'), applicationId: 'app3', decision: 'no' }), 423, 'RECORD_LOCKED');
    await rejects(setDecision({ client: db, sessionId, user: as('admin2'), applicationId: 'app2', decision: 'no' }), 403, 'OWN_RECORD');
  });
});

describe('getChanges', () => {
  it('nets each score and decision to first-from, last-to, and drops round trips', async () => {
    const sessionId = await launched();
    const target = db.tables.resumeScore.find((row) => row.candidateId === 'c1' && row.evaluatorId === 'm1');
    await overrideScore({ client: db, sessionId, user: as('admin1'), type: 'resume', scoreId: target.id, adminScore: 8 });
    await overrideScore({ client: db, sessionId, user: as('admin1'), type: 'resume', scoreId: target.id, adminScore: null });
    await setDecision({ client: db, sessionId, user: as('admin1'), applicationId: 'app1', decision: 'yes' });
    await setDecision({ client: db, sessionId, user: as('admin1'), applicationId: 'app1', decision: 'maybe_yes' });

    const { changes, total } = await getChanges({ client: db, sessionId, user: as('admin1') });
    expect(total).toBe(4);
    expect(changes).toMatchObject([{ kind: 'DECISION', fromValue: null, toValue: 'maybe_yes', candidateName: 'Cand 1', byName: 'Ada Admin' }]);
  });
});

describe('getCandidateCard', () => {
  it("refuses another team's candidate and a sealed one", async () => {
    const sessionId = await launched();
    await rejects(getCandidateCard({ client: db, sessionId, applicationId: 'app4', user: as('admin1') }), 404, 'NOT_ON_TEAM_LIST');
    await rejects(getCandidateCard({ client: db, sessionId, applicationId: 'app3', user: as('admin1') }), 423, 'RECORD_LOCKED');
  });

  it("carries Staging's overall: documents total plus capped participation", async () => {
    const sessionId = await launched();
    const card = await getCandidateCard({ client: db, sessionId, applicationId: 'app1', user: as('admin1') });
    // 2 / 10 / 10 averages 7.33; Info Sesh and Get to Know UC are 2 points.
    expect(card).toMatchObject({ total: 7.33, participation: 2, overall: 9.3, overallMax: 13 + 3 + 2 + 3 });

    // Last cycle's event does not count.
    const other = await getCandidateCard({ client: db, sessionId, applicationId: 'app5', user: as('admin1') });
    expect(other).toMatchObject({ total: 5.33, participation: 0, overall: 5.3 });
  });

  it('puts the overall on the team table, and nothing of it on a sealed row', async () => {
    const sessionId = await launched();
    const team = await getTeamView({ client: db, sessionId, user: as('admin1') });
    expect(team.overallMax).toBe(21);
    expect(team.candidates.find((row) => row.applicationId === 'app1')).toMatchObject({ participation: 2, overall: 9.3 });
    expect(team.candidates.find((row) => row.applicationId === 'app3')).not.toHaveProperty('overall');
    // The sealed candidate is never asked about.
    const asked = db.eventAttendance.findMany.mock.calls.flatMap(([args]) => args.where.candidateId.in ?? []);
    expect(asked).not.toContain('c3');
  });

  it("shows every grader's score with the outlier marked", async () => {
    const sessionId = await launched();
    const card = await getCandidateCard({ client: db, sessionId, applicationId: 'app1', user: as('admin1') });
    // Team members first, by name; then graders from outside the team.
    expect(card.docs.resume.rows.map((row) => [row.evaluatorId, row.isOutlier, row.onTeam])).toEqual([
      ['m2', false, true], ['m1', true, true], ['admin1', false, false]
    ]);
  });
});

describe('getCandidateCard: attendance and referrals', () => {
  it("shows the cycle's events they came to, Get to Know UC, and every referral", async () => {
    const sessionId = await launched();
    await joinSession({ client: db, sessionId, user: as('m1') });
    const card = await getCandidateCard({ client: db, sessionId, applicationId: 'app1', user: as('m1') });

    expect(card.attendance).toEqual({
      attended: [
        { id: 'e1', name: 'Info Sesh', startDate: new Date('2026-09-20') },
        { id: 'meeting-signup-1', name: 'Get to Know UC', startDate: new Date('2026-09-22T17:00:00Z'), isMeeting: true }
      ],
      // Get to Know UC is listed but is not one of the cycle's events.
      attendedCount: 1,
      eventCount: 2
    });
    expect(card.referrals).toEqual([
      { id: 'r1', source: 'MANUAL', referrerName: 'Pat Alum', relationship: 'Classmate', reason: null },
      { id: 'r2', source: 'PRE_APPLICATION', referrerName: 'Mia Member', relationship: 'Roommate', reason: 'Sharp and kind' }
    ]);
    // The whole room sees this: no referrer's address or account.
    expect(JSON.stringify(card.referrals)).not.toMatch(/mia@ucla\.edu|"m1"/);
  });

  it('is empty, not missing, for someone with neither', async () => {
    const sessionId = await launched();
    const card = await getCandidateCard({ client: db, sessionId, applicationId: 'app5', user: as('admin1') });
    expect(card.attendance).toEqual({ attended: [], attendedCount: 0, eventCount: 2 });
    expect(card.referrals).toEqual([]);
  });

  it('reads none of it for a sealed or off-team candidate', async () => {
    const sessionId = await launched();
    await rejects(getCandidateCard({ client: db, sessionId, applicationId: 'app3', user: as('admin1') }), 423, 'RECORD_LOCKED');
    await rejects(getCandidateCard({ client: db, sessionId, applicationId: 'app4', user: as('admin1') }), 404, 'NOT_ON_TEAM_LIST');
    for (const call of [db.events.findMany, db.eventRsvp.findMany, db.eventAttendance.findMany, db.meetingSignup.findFirst, db.referral.findMany, db.recruitingCycle.findUnique]) {
      expect(call).not.toHaveBeenCalled();
    }
  });

  it('fails the card rather than showing it without them', async () => {
    const sessionId = await launched();
    db.referral.findMany.mockRejectedValueOnce(new Error('database down'));
    await expect(getCandidateCard({ client: db, sessionId, applicationId: 'app1', user: as('admin1') })).rejects.toThrow('database down');
  });
});

describe('endSession', () => {
  it('any admin can end it; nothing changes afterwards, and it can still be read', async () => {
    const sessionId = await launched();
    await rejects(endSession({ client: db, sessionId, user: as('m1') }), 403, 'FORBIDDEN');

    const state = await endSession({ client: db, sessionId, user: as('admin2') });
    expect(state.session).toMatchObject({ status: 'ENDED', step: 'SUMMARY' });
    expect(nudgeReviewDelibsGlobal).toHaveBeenLastCalledWith({ sessionId, status: 'ENDED' });

    await rejects(setDecision({ client: db, sessionId, user: as('admin1'), applicationId: 'app1', decision: 'yes' }), 409, 'SESSION_ENDED');
    await expect(getChanges({ client: db, sessionId, user: as('m2') })).resolves.toMatchObject({ changes: [] });
  });

  it('frees the team for a new session and reports the last one held', async () => {
    const first = await launched();
    await endSession({ client: db, sessionId: first, user: as('admin1') });
    const { groups } = await getGroupStatuses({ client: db });
    expect(groups).toEqual([{ groupId: 'g1', open: null, last: expect.objectContaining({ id: first, changeCount: 0 }) }]);
    await expect(launched()).resolves.toBeTruthy();
  });
});
