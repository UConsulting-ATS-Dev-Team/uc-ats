import { describe, it, expect, vi } from 'vitest';
import {
  APPLICATION_DEPENDENTS,
  ApplicationMergeConflict,
  MERGE_CONFLICTS,
  REVIEW_FIELDS,
  SUBMISSION_FIELDS,
  appendIds,
  applyResubmission,
  findDuplicateApplicationGroups,
  mergeDuplicateApplications,
  replacementData,
  resubmissionPlan
} from './applicationResubmissions.js';

const EARLY = new Date('2026-09-20T10:00:00Z');
const LATE = new Date('2026-09-25T10:00:00Z');

const untouched = (overrides = {}) => ({
  id: 'app-1',
  responseID: 'old-1',
  supersededResponseIds: [],
  submittedAt: EARLY,
  resumeUrl: '/api/files/old/pdf',
  status: 'SUBMITTED',
  currentRound: '1',
  approved: null,
  resumeDecision: null,
  coffeeChatDecision: null,
  firstRoundDecision: null,
  finalRoundDecision: null,
  ...overrides
});

const incoming = (overrides = {}) => ({
  responseID: 'new-1',
  submittedAt: LATE,
  rawResponses: { q: 'a' },
  email: 'maria@ucla.edu',
  firstName: 'Maria',
  lastName: 'Lopez',
  studentId: '123456789',
  resumeUrl: '/api/files/new/pdf',
  ...overrides
});

describe('resubmissionPlan', () => {
  it('replaces when the new submission is later and nobody has reviewed the application', () => {
    expect(resubmissionPlan({ existing: untouched(), incoming: incoming() }))
      .toEqual({ action: 'REPLACE', reason: 'NEWER_SUBMISSION' });
  });

  it('treats a missing round as untouched, like round 1', () => {
    expect(resubmissionPlan({ existing: untouched({ currentRound: null }), incoming: incoming() }).action).toBe('REPLACE');
  });

  it('only records a submission that is not later', () => {
    expect(resubmissionPlan({ existing: untouched({ submittedAt: LATE }), incoming: incoming({ submittedAt: EARLY }) }))
      .toEqual({ action: 'RECORD_ONLY', reason: 'OLDER_SUBMISSION' });
    expect(resubmissionPlan({ existing: untouched({ submittedAt: LATE }), incoming: incoming({ submittedAt: LATE }) }).reason)
      .toBe('OLDER_SUBMISSION');
  });

  it.each([
    ['a decision is set', { firstRoundDecision: 'maybe_yes' }],
    ['the resume decision is set', { resumeDecision: 'no' }],
    ['the round has advanced', { currentRound: '2' }],
    ['the status has changed', { status: 'UNDER_REVIEW' }],
    ['approved is set', { approved: false }]
  ])('only records once review has started: %s', (_label, overrides) => {
    expect(resubmissionPlan({ existing: untouched(overrides), incoming: incoming() }))
      .toEqual({ action: 'RECORD_ONLY', reason: 'REVIEW_STARTED' });
  });

  it('only records for a sealed candidate', () => {
    expect(resubmissionPlan({ existing: untouched(), incoming: incoming(), candidateLocked: true }))
      .toEqual({ action: 'RECORD_ONLY', reason: 'RECORD_LOCKED' });
  });
});

describe('replacementData', () => {
  it('carries only submission fields and the superseded list', () => {
    const data = replacementData(untouched(), incoming({ status: 'ACCEPTED', currentRound: '4', cycleId: 'x', candidateId: 'y', id: 'z', testFor: 't' }));
    const allowed = new Set([...SUBMISSION_FIELDS, 'supersededResponseIds']);
    expect(Object.keys(data).every((key) => allowed.has(key))).toBe(true);
    for (const field of [...REVIEW_FIELDS, 'id', 'cycleId', 'candidateId', 'testFor']) {
      expect(data).not.toHaveProperty(field);
    }
    expect(data).toMatchObject({ responseID: 'new-1', resumeUrl: '/api/files/new/pdf', supersededResponseIds: ['old-1'] });
  });

  it('clears an optional answer the new submission left out, so an old blind resume does not linger', () => {
    const data = replacementData(untouched({ blindResumeUrl: '/api/files/old-blind/pdf' }), incoming());
    expect(data.blindResumeUrl).toBeNull();
    expect(data.videoUrl).toBeNull();
    // A required column the new response did not answer keeps the earlier value.
    expect(data).not.toHaveProperty('headshotUrl');
  });

  it('appends the replaced response once, never twice and never the new one', () => {
    expect(replacementData(untouched({ supersededResponseIds: ['older', 'old-1'] }), incoming()).supersededResponseIds)
      .toEqual(['older', 'old-1']);
    expect(appendIds(['a'], ['a', 'b', 'c'], 'c')).toEqual(['a', 'b']);
  });
});

const fakeClient = () => ({
  application: { updateMany: vi.fn(async () => ({ count: 1 })) },
  resumeUpload: { count: vi.fn(async () => 0), updateMany: vi.fn(), create: vi.fn() }
});

describe('applyResubmission', () => {
  it('replaces the row conditionally on it still being untouched', async () => {
    const client = fakeClient();
    const result = await applyResubmission(client, { existing: untouched(), incoming: incoming() });

    expect(result).toEqual({ action: 'REPLACE', reason: 'NEWER_SUBMISSION', applicationId: 'app-1' });
    const [{ where, data }] = client.application.updateMany.mock.calls[0];
    expect(where).toMatchObject({ id: 'app-1', responseID: 'old-1' });
    expect(where.AND).toEqual(expect.arrayContaining([{ status: 'SUBMITTED' }, { approved: null }]));
    expect(data.supersededResponseIds).toEqual(['old-1']);
  });

  it('records only the response id when review has started', async () => {
    const client = fakeClient();
    const result = await applyResubmission(client, { existing: untouched({ coffeeChatDecision: 'yes' }), incoming: incoming() });

    expect(result.action).toBe('RECORD_ONLY');
    expect(client.application.updateMany).toHaveBeenCalledWith({
      where: { id: 'app-1', NOT: [{ responseID: 'new-1' }, { supersededResponseIds: { has: 'new-1' } }] },
      data: { supersededResponseIds: { push: 'new-1' } }
    });
  });

  it('writes nothing for a response the row already holds', async () => {
    const client = fakeClient();
    const result = await applyResubmission(client, { existing: untouched({ supersededResponseIds: ['new-1'] }), incoming: incoming() });

    expect(result.reason).toBe('ALREADY_RECORDED');
    expect(client.application.updateMany).not.toHaveBeenCalled();
  });

  it('falls back to recording when the row changed between read and write', async () => {
    const client = fakeClient();
    client.application.updateMany.mockResolvedValueOnce({ count: 0 });
    const result = await applyResubmission(client, { existing: untouched(), incoming: incoming() });

    expect(result).toMatchObject({ action: 'RECORD_ONLY', reason: 'CHANGED_DURING_SYNC' });
    expect(client.application.updateMany).toHaveBeenCalledTimes(2);
    expect(client.application.updateMany.mock.calls[1][0].data).toEqual({ supersededResponseIds: { push: 'new-1' } });
  });

  it('keeps a portal resume history consistent when the form resume replaces it', async () => {
    const client = fakeClient();
    client.resumeUpload.count.mockResolvedValue(2);
    await applyResubmission(client, { existing: untouched(), incoming: incoming() });

    expect(client.resumeUpload.updateMany).toHaveBeenCalledWith({
      where: { applicationId: 'app-1', supersededAt: null },
      data: { supersededAt: expect.any(Date) }
    });
    expect(client.resumeUpload.create).toHaveBeenCalledWith({
      data: { applicationId: 'app-1', storagePath: null, sourceUrl: '/api/files/new/pdf', uploadedAt: LATE }
    });
  });
});

// ---------------------------------------------------------------------------
// An in-memory database for the merge: just enough of Prisma's where clauses
// ({ col: value }, { col: { in } }, { col: { not } }) to run it for real.
// ---------------------------------------------------------------------------

const matchesWhere = (row, where = {}) => Object.entries(where).every(([key, cond]) => {
  if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
    if ('in' in cond) return cond.in.includes(row[key]);
    if ('not' in cond) return row[key] !== cond.not;
  }
  return (row[key] ?? null) === cond;
});

const pick = (row, select) => (select
  ? Object.fromEntries(Object.keys(select).filter((key) => select[key] === true).map((key) => [key, row[key]]))
  : { ...row });

function fakeDb(seed) {
  const tables = { reviewDelibSession: [], resumeUpload: [], ...seed };
  const delegate = (model) => {
    tables[model] ??= [];
    return {
      findMany: vi.fn(async ({ where, select } = {}) => tables[model].filter((row) => matchesWhere(row, where)).map((row) => {
        const out = pick(row, select);
        if (select?.candidate) out.candidate = tables.candidate.find((c) => c.id === row.candidateId);
        return out;
      })),
      groupBy: vi.fn(async ({ by: [column], where }) => {
        const counts = new Map();
        for (const row of tables[model].filter((r) => matchesWhere(r, where))) {
          counts.set(row[column], (counts.get(row[column]) || 0) + 1);
        }
        return [...counts].map(([value, n]) => ({ [column]: value, _count: { _all: n } }));
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const rows = tables[model].filter((row) => matchesWhere(row, where));
        rows.forEach((row) => Object.assign(row, data));
        return { count: rows.length };
      }),
      update: vi.fn(async ({ where, data }) => Object.assign(tables[model].find((row) => row.id === where.id), data)),
      deleteMany: vi.fn(async ({ where }) => {
        const before = tables[model].length;
        tables[model] = tables[model].filter((row) => !matchesWhere(row, where));
        return { count: before - tables[model].length };
      })
    };
  };
  const client = {};
  for (const model of new Set(['application', 'candidate', 'resumeUpload', 'reviewDelibSession', ...APPLICATION_DEPENDENTS.map((d) => d.model)])) {
    client[model] = delegate(model);
  }
  return { client, tables };
}

const app = (id, overrides = {}) => ({
  id,
  candidateId: 'cand-1',
  cycleId: 'cycle-1',
  responseID: `resp-${id}`,
  supersededResponseIds: [],
  submittedAt: EARLY,
  rawResponses: { from: id },
  email: 'maria@ucla.edu',
  firstName: 'Maria',
  lastName: 'Lopez',
  studentId: '123456789',
  phoneNumber: '555',
  graduationYear: '2028',
  isTransferStudent: false,
  cumulativeGpa: 3.9,
  major1: 'Economics',
  isFirstGeneration: false,
  resumeUrl: `/api/files/${id}-resume/pdf`,
  headshotUrl: `/api/files/${id}-head/image`,
  blindResumeUrl: null,
  status: 'SUBMITTED',
  currentRound: '1',
  approved: null,
  resumeDecision: null,
  coffeeChatDecision: null,
  firstRoundDecision: null,
  finalRoundDecision: null,
  testFor: null,
  ...overrides
});

const seedGroup = (older = {}, newer = {}, extra = {}) => fakeDb({
  candidate: [{ id: 'cand-1', recordsLockedAt: null }],
  application: [app('older', older), app('newer', { submittedAt: LATE, ...newer })],
  ...extra
});

describe('mergeDuplicateApplications', () => {
  it('keeps the oldest row, with the latest submission\'s answers and every response id', async () => {
    const { client, tables } = seedGroup({ supersededResponseIds: ['ancient'] });
    const summary = await mergeDuplicateApplications(client, { survivorId: 'older', loserIds: ['newer'] });

    expect(tables.application.map((row) => row.id)).toEqual(['older']);
    const [survivor] = tables.application;
    expect(survivor).toMatchObject({
      responseID: 'resp-newer',
      resumeUrl: '/api/files/newer-resume/pdf',
      rawResponses: { from: 'newer' },
      submittedAt: LATE
    });
    expect(survivor.supersededResponseIds.sort()).toEqual(['ancient', 'resp-older'].sort());
    expect(summary).toMatchObject({ survivorId: 'older', contentFrom: 'newer', responseID: 'resp-newer' });
  });

  it('coalesces decisions across the rows and says where each came from', async () => {
    const { client, tables } = seedGroup(
      { resumeDecision: 'yes', currentRound: '2' },
      { coffeeChatDecision: 'maybe_yes', currentRound: '2' }
    );
    const summary = await mergeDuplicateApplications(client, { survivorId: 'older', loserIds: ['newer'] });

    expect(tables.application[0]).toMatchObject({ resumeDecision: 'yes', coffeeChatDecision: 'maybe_yes', currentRound: '2', status: 'SUBMITTED' });
    expect(summary.review.resumeDecision).toEqual({ value: 'yes', from: 'older' });
    expect(summary.review.coffeeChatDecision).toEqual({ value: 'maybe_yes', from: 'newer' });
  });

  it('refuses two different decisions for the same round, changing nothing', async () => {
    const { client, tables } = seedGroup({ resumeDecision: 'yes' }, { resumeDecision: 'no' });

    const error = await mergeDuplicateApplications(client, { survivorId: 'older', loserIds: ['newer'] }).catch((e) => e);
    expect(error).toBeInstanceOf(ApplicationMergeConflict);
    expect(error.code).toBe(MERGE_CONFLICTS.REVIEW_CONFLICT);
    expect(tables.application).toHaveLength(2);
  });

  it('refuses rounds advanced to different places', async () => {
    const { client } = seedGroup({ currentRound: '2' }, { currentRound: '3' });
    await expect(mergeDuplicateApplications(client, { survivorId: 'older', loserIds: ['newer'] }))
      .rejects.toMatchObject({ code: MERGE_CONFLICTS.REVIEW_CONFLICT });
  });

  it('refuses a sealed candidate', async () => {
    const { client, tables } = seedGroup();
    tables.candidate[0].recordsLockedAt = new Date();
    await expect(mergeDuplicateApplications(client, { survivorId: 'older', loserIds: ['newer'] }))
      .rejects.toMatchObject({ code: MERGE_CONFLICTS.RECORD_LOCKED });
  });

  it('re-points every dependent table onto the survivor before deleting the loser', async () => {
    const extra = Object.fromEntries(APPLICATION_DEPENDENTS.map((d, i) => [
      d.model,
      [{ id: `${d.table}-1`, [d.column]: 'newer', interviewId: `int-${i}`, evaluatorId: 'e', sessionId: `s-${i}`, fromRound: '1', outcome: 'ADVANCE', clientId: 'c', status: 'CONFIRMED', revokedAt: null, cycleId: 'cycle-1', outlierApplicationIds: [] }]
    ]));
    extra.reviewDelibSession = [
      ...extra.reviewDelibSession,
      { id: 'delib-2', cycleId: 'cycle-1', currentApplicationId: null, outlierApplicationIds: ['older', 'x', 'newer'] }
    ];
    const { client, tables } = seedGroup({}, {}, extra);

    const summary = await mergeDuplicateApplications(client, { survivorId: 'older', loserIds: ['newer'] });

    for (const dependent of APPLICATION_DEPENDENTS) {
      expect(tables[dependent.model].filter((row) => row[dependent.column] === 'newer'), dependent.table).toHaveLength(0);
      expect(summary.moved[dependent.table], dependent.table).toBe(1);
    }
    expect(tables.reviewDelibSession.find((s) => s.id === 'delib-2').outlierApplicationIds).toEqual(['older', 'x']);
    expect(tables.application.map((row) => row.id)).toEqual(['older']);
    const deleteOrder = client.application.deleteMany.mock.invocationCallOrder[0];
    for (const dependent of APPLICATION_DEPENDENTS) {
      expect(client[dependent.model].updateMany.mock.invocationCallOrder[0]).toBeLessThan(deleteOrder);
    }
  });

  it('refuses when the same evaluator evaluated both rows for one interview', async () => {
    const { client, tables } = seedGroup({}, {}, {
      interviewEvaluation: [
        { id: 'ev-1', applicationId: 'older', interviewId: 'int-1', evaluatorId: 'user-1' },
        { id: 'ev-2', applicationId: 'newer', interviewId: 'int-1', evaluatorId: 'user-1' }
      ]
    });

    await expect(mergeDuplicateApplications(client, { survivorId: 'older', loserIds: ['newer'] }))
      .rejects.toMatchObject({ code: MERGE_CONFLICTS.UNIQUE_COLLISION });
    expect(tables.interviewEvaluation.map((row) => row.applicationId)).toEqual(['older', 'newer']);
    expect(client.application.deleteMany).not.toHaveBeenCalled();
  });

  it('turns a unique violation it did not foresee into the same conflict', async () => {
    const { client } = seedGroup({}, {}, { comment: [{ id: 'c-1', applicationId: 'newer' }] });
    client.comment.updateMany.mockRejectedValueOnce(Object.assign(new Error('Unique constraint failed'), { code: 'P2002' }));

    await expect(mergeDuplicateApplications(client, { survivorId: 'older', loserIds: ['newer'] }))
      .rejects.toMatchObject({ name: 'ApplicationMergeConflict', code: MERGE_CONFLICTS.UNIQUE_COLLISION });
    expect(client.application.deleteMany).not.toHaveBeenCalled();
  });

  it('allows signups that only collide once one of them is cancelled', async () => {
    const { client } = seedGroup({}, {}, {
      interviewSlotSignup: [
        { id: 's-1', applicationId: 'older', interviewId: 'int-1', status: 'CANCELLED' },
        { id: 's-2', applicationId: 'newer', interviewId: 'int-1', status: 'CONFIRMED' }
      ]
    });
    await expect(mergeDuplicateApplications(client, { survivorId: 'older', loserIds: ['newer'] })).resolves.toBeTruthy();
  });

  it('refuses when a portal resume history sits on a row whose answers are not kept', async () => {
    const { client } = seedGroup({}, {}, {
      resumeUpload: [{ id: 'ru-1', applicationId: 'older', supersededAt: null }]
    });
    await expect(mergeDuplicateApplications(client, { survivorId: 'older', loserIds: ['newer'] }))
      .rejects.toMatchObject({ code: MERGE_CONFLICTS.RESUME_VERSIONS });
  });
});

describe('findDuplicateApplicationGroups', () => {
  it('reports each duplicated candidate, oldest first, without reading supersededResponseIds', async () => {
    const { client } = fakeDb({
      candidate: [{ id: 'cand-1', recordsLockedAt: null }],
      application: [
        app('newer', { submittedAt: LATE }),
        app('older'),
        app('solo', { candidateId: 'cand-2' })
      ],
      comment: [{ id: 'c-1', applicationId: 'newer' }]
    });

    const groups = await findDuplicateApplicationGroups(client, { cycleId: 'cycle-1' });

    expect(groups).toHaveLength(1);
    expect(groups[0].dependents.comments).toEqual({ newer: 1 });
    expect(groups[0].plan).toMatchObject({ survivorId: 'older', loserIds: ['newer'], contentFrom: 'newer', conflicts: [] });
    for (const [args] of client.application.findMany.mock.calls) {
      expect(args.select).toBeDefined();
      expect(args.select).not.toHaveProperty('supersededResponseIds');
    }
  });
});
