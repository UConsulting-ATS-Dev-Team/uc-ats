// Decision processing moves real people through recruiting and hands out member
// accounts, so these pin down who moves where, whose account changes, whose
// record is sealed, and which emails are queued - and that nothing is sent.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invalidateUserCache } from '../middleware/auth.js';
import { decisionFor, planDecisions, processRoundDecisions } from './decisionProcessing.js';

vi.mock('../prismaClient.js', () => ({ default: {} }));
vi.mock('../middleware/auth.js', () => ({ invalidateUserCache: vi.fn() }));

const application = (overrides = {}) => ({
  id: 'app-1',
  candidateId: 'cand-1',
  email: 'sam@ucla.edu',
  firstName: 'Sam',
  lastName: 'Lee',
  studentId: '111',
  graduationYear: '2029',
  status: 'UNDER_REVIEW',
  approved: null,
  currentRound: '4',
  resumeDecision: 'yes',
  coffeeChatDecision: 'yes',
  firstRoundDecision: 'yes',
  finalRoundDecision: null,
  ...overrides
});

const cycle = { id: 'cycle-1' };
const processedBy = { id: 'exec-1' };

function fakeClient({ applications, users = [] }) {
  const client = {
    application: {
      findMany: vi.fn().mockResolvedValue(applications),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    user: {
      findUnique: vi.fn(({ where }) => Promise.resolve(users.find((u) => u.studentId === where.studentId) ?? null)),
      findFirst: vi.fn(({ where }) =>
        Promise.resolve(users.find((u) => u.email.toLowerCase() === where.email.equals.toLowerCase()) ?? null)
      ),
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn(({ data }) => Promise.resolve({ id: `new-user-${data.studentId}` }))
    },
    candidate: {
      findFirst: vi.fn().mockResolvedValue(null),
      updateMany: vi.fn().mockResolvedValue({ count: 1 })
    },
    execAccessLog: { create: vi.fn().mockResolvedValue({}) },
    decisionBatch: { create: vi.fn().mockResolvedValue({ id: 'batch-1' }) },
    decisionMessage: { createMany: vi.fn(({ data }) => Promise.resolve({ count: data.length })) }
  };
  client.$transaction = vi.fn((work) => work(client));
  return client;
}

const queuedMessages = (client) => client.decisionMessage.createMany.mock.calls[0][0].data;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('reading a decision', () => {
  it("uses the round's own decision", () => {
    expect(decisionFor(application({ finalRoundDecision: 'no' }), '4')).toBe('no');
  });

  // The bug this replaces: first-round processing left approved = true, and final
  // processing then accepted people nobody had decided on.
  it("never takes a later round's decision from approved", () => {
    expect(decisionFor(application({ approved: true, finalRoundDecision: null }), '4')).toBeNull();
  });

  it('falls back to approved for resume review, which predates per-round decisions', () => {
    expect(decisionFor(application({ resumeDecision: null, approved: false }), '1')).toBe('no');
  });

  it('treats a maybe as no decision yet', () => {
    expect(decisionFor(application({ finalRoundDecision: 'maybe_yes' }), '4')).toBeNull();
  });
});

describe('planning a round', () => {
  it('advances yeses, rejects nos and holds everyone undecided', () => {
    const yes = application({ id: 'yes', currentRound: '2', coffeeChatDecision: 'yes' });
    const no = application({ id: 'no', currentRound: '2', coffeeChatDecision: 'no' });
    const maybe = application({ id: 'maybe', currentRound: '2', coffeeChatDecision: null });
    const plan = planDecisions([yes, no, maybe], '2');
    expect(plan.advance).toEqual([yes]);
    expect(plan.reject).toEqual([no]);
    expect(plan.undecided).toEqual([maybe]);
    expect(plan.accept).toEqual([]);
  });

  it('accepts rather than advances in the final round', () => {
    const plan = planDecisions([application({ finalRoundDecision: 'yes' })], '4');
    expect(plan.accept).toHaveLength(1);
    expect(plan.advance).toHaveLength(0);
  });

  it('leaves applications that were already settled alone', () => {
    const plan = planDecisions(
      [application({ status: 'REJECTED', finalRoundDecision: 'no' }), application({ status: 'ACCEPTED', finalRoundDecision: 'yes' })],
      '4'
    );
    expect(plan.settled).toHaveLength(2);
    expect(plan.reject).toHaveLength(0);
    expect(plan.accept).toHaveLength(0);
  });
});

describe('processing a round', () => {
  it('only reads applications still open at that round', async () => {
    const client = fakeClient({ applications: [] });
    await processRoundDecisions({ cycle, round: '3', processedBy }, client);
    expect(client.application.findMany.mock.calls[0][0].where).toEqual({
      cycleId: 'cycle-1',
      currentRound: '3',
      status: { notIn: ['ACCEPTED', 'REJECTED'] }
    });
  });

  it('makes no batch and changes nothing when no decisions are ready', async () => {
    const client = fakeClient({ applications: [application({ finalRoundDecision: null })] });
    const result = await processRoundDecisions({ cycle, round: '4', processedBy }, client);
    expect(result.batchId).toBeNull();
    expect(result.summary.undecided).toBe(1);
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it('advances and rejects in an early round, clearing approved and leaving accounts alone', async () => {
    const client = fakeClient({
      applications: [
        application({ id: 'app-yes', currentRound: '1', resumeDecision: 'yes' }),
        application({ id: 'app-no', currentRound: '1', resumeDecision: 'no' }),
        application({ id: 'app-maybe', currentRound: '1', resumeDecision: 'maybe_yes' })
      ]
    });

    const { batchId, summary } = await processRoundDecisions({ cycle, round: '1', processedBy }, client);

    expect(batchId).toBe('batch-1');
    expect(client.application.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['app-yes'] }, currentRound: '1', status: { notIn: ['ACCEPTED', 'REJECTED'] } },
      data: { status: 'UNDER_REVIEW', currentRound: '2', approved: null }
    });
    expect(client.application.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['app-no'] }, currentRound: '1', status: { notIn: ['ACCEPTED', 'REJECTED'] } },
      data: { status: 'REJECTED', approved: false }
    });
    expect(client.user.update).not.toHaveBeenCalled();
    expect(client.user.create).not.toHaveBeenCalled();
    expect(client.candidate.updateMany).not.toHaveBeenCalled();

    expect(queuedMessages(client)).toEqual([
      expect.objectContaining({ applicationId: 'app-yes', outcome: 'ADVANCED', fromRound: '1', toRound: '2' }),
      expect.objectContaining({ applicationId: 'app-no', outcome: 'REJECTED', fromRound: '1', toRound: null })
    ]);
    expect(client.decisionBatch.create.mock.calls[0][0].data.templates).toHaveProperty('ADVANCED');
    expect(summary).toMatchObject({ advanced: 1, rejected: 1, undecided: 1, emailsQueued: 2 });
  });

  it('makes final-round acceptances members, creates missing accounts, and seals their records', async () => {
    const client = fakeClient({
      applications: [
        application({ id: 'app-sam', finalRoundDecision: 'yes' }),
        application({ id: 'app-ava', candidateId: 'cand-ava', email: 'Ava@UCLA.edu', firstName: 'Ava', studentId: '222', finalRoundDecision: 'yes' }),
        application({ id: 'app-max', candidateId: 'cand-max', email: 'max@ucla.edu', firstName: 'Max', studentId: '333', finalRoundDecision: 'no' })
      ],
      users: [{ id: 'user-sam', role: 'USER', isActive: true, email: 'sam@ucla.edu', studentId: '111' }]
    });

    const { summary } = await processRoundDecisions({ cycle, round: '4', processedBy }, client);

    expect(client.user.update).toHaveBeenCalledWith({
      where: { id: 'user-sam' },
      data: { role: 'MEMBER', isExternalTalent: false }
    });

    const created = client.user.create.mock.calls[0][0].data;
    expect(created).toMatchObject({ email: 'ava@ucla.edu', studentId: '222', role: 'MEMBER', fullName: 'Ava Lee' });
    expect(created.password).toMatch(/^\$2[aby]\$/);

    // Sam and Ava are sealed; Max, who was rejected, is not.
    expect(client.candidate.updateMany.mock.calls.map(([args]) => args.where.id)).toEqual(['cand-1', 'cand-ava']);
    expect(client.execAccessLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'AUTO_LOCK', candidateId: 'cand-1', userId: 'exec-1' })
    });
    expect(invalidateUserCache).toHaveBeenCalledWith(['user-sam']);

    expect(queuedMessages(client).map((m) => [m.applicationId, m.outcome, m.userId, m.needsInvite])).toEqual([
      ['app-max', 'REJECTED', null, false],
      ['app-sam', 'ACCEPTED', 'user-sam', false],
      ['app-ava', 'ACCEPTED', 'new-user-222', true]
    ]);
    expect(summary).toMatchObject({
      accepted: 2,
      rejected: 1,
      membersPromoted: 1,
      membersCreated: 1,
      recordsSealed: 2,
      emailsQueued: 3,
      conflicts: []
    });
  });

  it('leaves an existing member or admin account as it is', async () => {
    const client = fakeClient({
      applications: [application({ finalRoundDecision: 'yes' })],
      users: [{ id: 'user-admin', role: 'ADMIN', isActive: true, email: 'sam@ucla.edu', studentId: '111' }]
    });
    await processRoundDecisions({ cycle, round: '4', processedBy }, client);
    expect(client.user.update).not.toHaveBeenCalled();
    expect(client.user.create).not.toHaveBeenCalled();
  });

  it('holds back an account change it cannot make safely, but still seals and queues', async () => {
    const client = fakeClient({
      applications: [application({ id: 'app-sam', finalRoundDecision: 'yes' })],
      users: [
        { id: 'user-a', role: 'USER', isActive: true, email: 'someone-else@ucla.edu', studentId: '111' },
        { id: 'user-b', role: 'USER', isActive: true, email: 'sam@ucla.edu', studentId: '999' }
      ]
    });

    const { summary } = await processRoundDecisions({ cycle, round: '4', processedBy }, client);

    expect(client.user.update).not.toHaveBeenCalled();
    expect(client.user.create).not.toHaveBeenCalled();
    expect(summary.conflicts).toEqual([
      expect.objectContaining({ applicationId: 'app-sam', reason: expect.stringMatching(/two different accounts/) })
    ]);
    expect(client.candidate.updateMany).toHaveBeenCalledTimes(1);
    expect(queuedMessages(client)[0]).toMatchObject({ outcome: 'ACCEPTED', userId: null, needsInvite: false });
  });
});
