import { describe, it, expect, vi } from 'vitest';
import {
  APPLICATION_DEPENDENTS,
  ApplicationMergeConflict,
  CONTENT_RULES,
  MERGE_CONFLICTS,
  REVIEW_FIELDS,
  SUBMISSION_FIELDS,
  appendIds,
  applyResubmission,
  chooseContent,
  fileSubmission,
  findDuplicateApplicationGroups,
  findReviewEvidence,
  mergeDuplicateApplications,
  replacementData,
  resubmissionPlan
} from './applicationResubmissions.js';

const EARLY = new Date('2026-09-20T10:00:00Z');
const MIDDLE = new Date('2026-09-22T10:00:00Z');
const LATE = new Date('2026-09-25T10:00:00Z');

// ---------------------------------------------------------------------------
// An in-memory database: just enough of Prisma's where clauses and writes to
// run the service for real against rows a test can inspect afterwards.
// ---------------------------------------------------------------------------

const ms = (value) => (value instanceof Date ? value.getTime() : Date.parse(value));

function matchesWhere(row, where = {}) {
  return Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return cond.some((sub) => matchesWhere(row, sub));
    if (key === 'AND') return cond.every((sub) => matchesWhere(row, sub));
    if (key === 'NOT') return (Array.isArray(cond) ? cond : [cond]).every((sub) => !matchesWhere(row, sub));
    const value = row[key] ?? null;
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return cond.in.includes(value);
      if ('not' in cond) return value !== cond.not;
      if ('gte' in cond) return value !== null && ms(value) >= ms(cond.gte);
      if ('has' in cond) return (value || []).includes(cond.has);
      if ('array_contains' in cond) return Array.isArray(value) && cond.array_contains.every((v) => value.includes(v));
      if ('equals' in cond) return cond.mode === 'insensitive'
        ? String(value ?? '').toLowerCase() === String(cond.equals).toLowerCase()
        : value === cond.equals;
    }
    return value === cond;
  });
}

const pick = (row, select) => (select
  ? Object.fromEntries(Object.keys(select).filter((key) => select[key] === true).map((key) => [key, row[key]]))
  : { ...row });

const applyData = (row, data) => {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && 'push' in value) row[key] = [...(row[key] || []), value.push];
    else row[key] = value;
  }
};

function fakeDb(seed = {}) {
  const tables = { candidate: [], application: [], ...seed };
  const calls = [];
  const delegate = (model) => {
    tables[model] ??= [];
    const rows = (where) => tables[model].filter((row) => matchesWhere(row, where));
    return {
      findMany: vi.fn(async ({ where, select, take } = {}) => {
        calls.push(`${model}.findMany`);
        let found = rows(where);
        if (model === 'application') found = found.sort((a, b) => ms(a.submittedAt) - ms(b.submittedAt));
        if (take) found = found.slice(0, take);
        return found.map((row) => {
          const out = pick(row, select);
          if (select?.candidate) out.candidate = tables.candidate.find((c) => c.id === row.candidateId);
          return out;
        });
      }),
      count: vi.fn(async ({ where } = {}) => rows(where).length),
      groupBy: vi.fn(async ({ by: [column], where }) => {
        const counts = new Map();
        for (const row of rows(where)) counts.set(row[column], (counts.get(row[column]) || 0) + 1);
        return [...counts].map(([value, n]) => ({ [column]: value, _count: { _all: n } }));
      }),
      create: vi.fn(async ({ data }) => {
        calls.push(`${model}.create`);
        const row = { id: data.id ?? `${model}-${tables[model].length + 1}`, supersededResponseIds: [], ...data };
        tables[model].push(row);
        return row;
      }),
      updateMany: vi.fn(async ({ where, data }) => {
        const matched = rows(where);
        matched.forEach((row) => applyData(row, data));
        return { count: matched.length };
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = tables[model].find((r) => r.id === where.id);
        applyData(row, data);
        return row;
      }),
      deleteMany: vi.fn(async ({ where }) => {
        const before = tables[model].length;
        tables[model] = tables[model].filter((row) => !matchesWhere(row, where));
        return { count: before - tables[model].length };
      })
    };
  };
  const client = {
    $executeRaw: vi.fn(async (strings, ...values) => {
      calls.push(`lock:${values.join(',')}`);
      return 1;
    })
  };
  for (const model of new Set([
    'application', 'candidate', 'resumeUpload', 'reviewDelibSession',
    'resumeScore', 'coverLetterScore', 'videoScore',
    ...APPLICATION_DEPENDENTS.map((d) => d.model)
  ])) {
    client[model] = delegate(model);
  }
  return { client, tables, calls };
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

const candidateRow = (overrides = {}) => ({ id: 'cand-1', email: 'maria@ucla.edu', recordsLockedAt: null, ...overrides });

// ---------------------------------------------------------------------------

describe('resubmissionPlan', () => {
  const existing = app('app-1');

  it('replaces when the new submission is later and nobody has reviewed the application', () => {
    expect(resubmissionPlan({ existing, incoming: incoming(), reviewEvidence: { started: false } }))
      .toEqual({ action: 'REPLACE', reason: 'NEWER_SUBMISSION' });
  });

  it('treats a missing round as untouched, like round 1', () => {
    expect(resubmissionPlan({ existing: app('a', { currentRound: null }), incoming: incoming() }).action).toBe('REPLACE');
  });

  it('only records a submission that is not later', () => {
    expect(resubmissionPlan({ existing: app('a', { submittedAt: LATE }), incoming: incoming({ submittedAt: EARLY }) }))
      .toEqual({ action: 'RECORD_ONLY', reason: 'OLDER_SUBMISSION' });
    expect(resubmissionPlan({ existing: app('a', { submittedAt: LATE }), incoming: incoming({ submittedAt: LATE }) }).reason)
      .toBe('OLDER_SUBMISSION');
  });

  it.each([
    ['a decision is set', { firstRoundDecision: 'maybe_yes' }],
    ['the resume decision is set', { resumeDecision: 'no' }],
    ['the round has advanced', { currentRound: '2' }],
    ['the status has changed', { status: 'UNDER_REVIEW' }],
    ['approved is set', { approved: false }]
  ])('only records once review has started: %s', (_label, overrides) => {
    expect(resubmissionPlan({ existing: app('a', overrides), incoming: incoming() }))
      .toEqual({ action: 'RECORD_ONLY', reason: 'REVIEW_STARTED' });
  });

  it('only records when the database shows review the row\'s own columns do not', () => {
    expect(resubmissionPlan({ existing, incoming: incoming(), reviewEvidence: { started: true } }))
      .toEqual({ action: 'RECORD_ONLY', reason: 'REVIEW_STARTED' });
  });

  it('only records for a sealed candidate', () => {
    expect(resubmissionPlan({ existing, incoming: incoming(), candidateLocked: true }))
      .toEqual({ action: 'RECORD_ONLY', reason: 'RECORD_LOCKED' });
  });
});

describe('replacementData', () => {
  it('carries only submission fields and the superseded push', () => {
    const data = replacementData(app('app-1'), incoming({ status: 'ACCEPTED', currentRound: '4', cycleId: 'x', candidateId: 'y', id: 'z', testFor: 't' }));
    const allowed = new Set([...SUBMISSION_FIELDS, 'supersededResponseIds']);
    expect(Object.keys(data).every((key) => allowed.has(key))).toBe(true);
    for (const field of [...REVIEW_FIELDS, 'id', 'cycleId', 'candidateId', 'testFor']) {
      expect(data).not.toHaveProperty(field);
    }
    expect(data).toMatchObject({ responseID: 'new-1', resumeUrl: '/api/files/new/pdf' });
  });

  it('pushes the replaced response rather than writing the whole list', () => {
    expect(replacementData(app('app-1', { supersededResponseIds: ['older'] }), incoming()).supersededResponseIds)
      .toEqual({ push: 'resp-app-1' });
  });

  it('clears an optional answer the new submission left out, so an old blind resume does not linger', () => {
    const data = replacementData(app('app-1', { blindResumeUrl: '/api/files/old-blind/pdf' }), incoming());
    expect(data.blindResumeUrl).toBeNull();
    expect(data.videoUrl).toBeNull();
    // A required column the new response did not answer keeps the earlier value.
    expect(data).not.toHaveProperty('headshotUrl');
  });

  it('appendIds keeps each id once and never the excluded one', () => {
    expect(appendIds(['a'], ['a', 'b', 'c'], 'c')).toEqual(['a', 'b']);
  });
});

describe('findReviewEvidence', () => {
  const seed = (extra) => fakeDb({ candidate: [candidateRow()], application: [app('app-1')], ...extra });
  const evidence = (client) => findReviewEvidence(client, { application: app('app-1'), candidateId: 'cand-1', cycleId: 'cycle-1' });

  it('finds nothing on an untouched application', async () => {
    expect((await evidence(seed().client)).started).toBe(false);
  });

  it('counts a document score for the candidate in the cycle', async () => {
    const { client } = seed({ coverLetterScore: [{ id: 's', candidateId: 'cand-1', cycleId: 'cycle-1', createdAt: MIDDLE }] });
    expect(await evidence(client)).toMatchObject({ started: true, scores: 1 });
  });

  it('counts a cycle-less legacy score written after the submission, not one from before it', async () => {
    const after = seed({ resumeScore: [{ id: 's', candidateId: 'cand-1', cycleId: null, createdAt: MIDDLE }] });
    expect((await evidence(after.client)).started).toBe(true);
    const before = seed({ resumeScore: [{ id: 's', candidateId: 'cand-1', cycleId: null, createdAt: new Date('2026-01-01') }] });
    expect((await evidence(before.client)).started).toBe(false);
  });

  it('ignores another cycle\'s score', async () => {
    const { client } = seed({ resumeScore: [{ id: 's', candidateId: 'cand-1', cycleId: 'cycle-0', createdAt: MIDDLE }] });
    expect((await evidence(client)).started).toBe(false);
  });

  it.each(APPLICATION_DEPENDENTS.filter((d) => d.table !== 'resume_uploads'))('counts a $table row', async (dependent) => {
    const { client } = seed({ [dependent.model]: [{ id: 'd', [dependent.column]: 'app-1' }] });
    expect(await evidence(client)).toMatchObject({ started: true, dependents: { [dependent.table]: 1 } });
  });

  it('does not count a portal resume replacement, which is the candidate\'s own act', async () => {
    const { client } = seed({ resumeUpload: [{ id: 'ru', applicationId: 'app-1', supersededAt: null }] });
    expect((await evidence(client)).started).toBe(false);
  });

  it('counts a review deliberation walkthrough that lists the application', async () => {
    const { client } = seed({ reviewDelibSession: [{ id: 'rd', cycleId: 'cycle-1', currentApplicationId: null, outlierApplicationIds: ['x', 'app-1'] }] });
    expect((await evidence(client)).started).toBe(true);
  });
});

describe('applyResubmission', () => {
  const seed = (overrides = {}, extra = {}) =>
    fakeDb({ candidate: [candidateRow()], application: [app('app-1', overrides)], ...extra });

  it('replaces the row conditionally on it still being untouched, pushing the old response id', async () => {
    const { client, tables } = seed({ supersededResponseIds: ['ancient'] });
    const result = await applyResubmission(client, { existing: { ...tables.application[0] }, incoming: incoming() });

    expect(result).toEqual({ action: 'REPLACE', reason: 'NEWER_SUBMISSION', applicationId: 'app-1', previousResponseID: 'resp-app-1' });
    const [{ where, data }] = client.application.updateMany.mock.calls[0];
    expect(where).toMatchObject({ id: 'app-1', responseID: 'resp-app-1' });
    expect(where.AND).toEqual(expect.arrayContaining([{ status: 'SUBMITTED' }, { approved: null }]));
    expect(data.supersededResponseIds).toEqual({ push: 'resp-app-1' });
    expect(tables.application[0]).toMatchObject({ responseID: 'new-1', supersededResponseIds: ['ancient', 'resp-app-1'] });
  });

  it('does not replace answers a grader has scored', async () => {
    const { client, tables } = seed({}, { resumeScore: [{ id: 's', candidateId: 'cand-1', cycleId: 'cycle-1', createdAt: MIDDLE }] });
    const result = await applyResubmission(client, { existing: { ...tables.application[0] }, incoming: incoming() });

    expect(result).toMatchObject({ action: 'RECORD_ONLY', reason: 'REVIEW_STARTED', previousResponseID: null });
    expect(tables.application[0]).toMatchObject({ responseID: 'resp-app-1', resumeUrl: '/api/files/app-1-resume/pdf', supersededResponseIds: ['new-1'] });
  });

  it('does not replace answers someone commented on', async () => {
    const { client, tables } = seed({}, { comment: [{ id: 'c', applicationId: 'app-1' }] });
    const result = await applyResubmission(client, { existing: { ...tables.application[0] }, incoming: incoming() });
    expect(result.reason).toBe('REVIEW_STARTED');
    expect(tables.application[0].responseID).toBe('resp-app-1');
  });

  it('still replaces when the only row on it is a portal resume version', async () => {
    const { client, tables } = seed({}, { resumeUpload: [{ id: 'ru', applicationId: 'app-1', supersededAt: null }] });
    const result = await applyResubmission(client, { existing: { ...tables.application[0] }, incoming: incoming() });
    expect(result.action).toBe('REPLACE');
    // ...and keeps that history consistent: the old current version is closed
    // and the form's new resume gets a row of its own.
    expect(tables.resumeUpload.find((r) => r.id === 'ru').supersededAt).toBeInstanceOf(Date);
    expect(tables.resumeUpload.find((r) => r.id !== 'ru')).toMatchObject({ sourceUrl: '/api/files/new/pdf', storagePath: null, uploadedAt: LATE });
  });

  it('records only the response id when a review field is set', async () => {
    const { client } = seed({ coffeeChatDecision: 'yes' });
    const result = await applyResubmission(client, { existing: app('app-1', { coffeeChatDecision: 'yes' }), incoming: incoming() });

    expect(result.action).toBe('RECORD_ONLY');
    expect(client.application.updateMany).toHaveBeenCalledWith({
      where: { id: 'app-1', NOT: [{ responseID: 'new-1' }, { supersededResponseIds: { has: 'new-1' } }] },
      data: { supersededResponseIds: { push: 'new-1' } }
    });
  });

  it('writes nothing for a response the row already holds', async () => {
    const { client } = seed();
    const result = await applyResubmission(client, { existing: app('app-1', { supersededResponseIds: ['new-1'] }), incoming: incoming() });
    expect(result.reason).toBe('ALREADY_RECORDED');
    expect(client.application.updateMany).not.toHaveBeenCalled();
  });

  it('falls back to recording when a reviewer wrote a decision between read and write', async () => {
    const { client, tables } = seed();
    const read = { ...tables.application[0] };
    tables.application[0].resumeDecision = 'yes';
    const result = await applyResubmission(client, { existing: read, incoming: incoming() });

    expect(result).toMatchObject({ action: 'RECORD_ONLY', reason: 'CHANGED_DURING_SYNC' });
    expect(tables.application[0]).toMatchObject({ responseID: 'resp-app-1', supersededResponseIds: ['new-1'] });
  });
});

describe('fileSubmission', () => {
  const file = (client, overrides = {}) => fileSubmission(client, {
    candidateId: 'cand-1',
    cycleId: 'cycle-1',
    record: incoming(),
    createData: { ...incoming(), candidateId: 'cand-1', cycleId: 'cycle-1', currentRound: '1' },
    ...overrides
  });

  it('takes the candidate-and-cycle lock before reading anything', async () => {
    const { client, calls } = fakeDb({ candidate: [candidateRow()] });
    await file(client);
    expect(calls[0]).toBe('lock:cand-1|cycle-1');
    expect(calls.indexOf('application.findMany')).toBeGreaterThan(0);
  });

  it('creates the first application, inside the lock', async () => {
    const { client, tables, calls } = fakeDb({ candidate: [candidateRow()] });
    const result = await file(client);
    expect(result).toMatchObject({ action: 'CREATED', reason: 'FIRST_SUBMISSION' });
    expect(tables.application).toHaveLength(1);
    expect(calls.indexOf('application.create')).toBeGreaterThan(calls.indexOf('lock:cand-1|cycle-1'));
  });

  it('folds a second submission into the application on file', async () => {
    const { client, tables } = fakeDb({ candidate: [candidateRow()], application: [app('app-1')] });
    const result = await file(client);
    expect(result).toMatchObject({ action: 'REPLACE', applicationId: 'app-1', previousResponseID: 'resp-app-1' });
    expect(tables.application).toHaveLength(1);
  });

  it('files a response whose UID and address belong to different people as its own application', async () => {
    const { client, tables } = fakeDb({ candidate: [candidateRow()], application: [app('app-1')] });
    const result = await file(client, { identityConflict: true });
    expect(result).toMatchObject({ action: 'CREATED', reason: 'IDENTITY_CONFLICT' });
    expect(tables.application).toHaveLength(2);
    expect(tables.application[0]).toMatchObject({ responseID: 'resp-app-1', supersededResponseIds: [] });
  });
});

// ---------------------------------------------------------------------------
// The cleanup.
// ---------------------------------------------------------------------------

describe('chooseContent', () => {
  const older = app('older');
  const middle = app('middle', { submittedAt: MIDDLE });
  const newer = app('newer', { submittedAt: LATE });
  const ordered = [older, middle, newer];

  it('a. keeps the only row with review on it, even when a later submission exists', () => {
    expect(chooseContent(ordered, { dependents: { comments: { older: 1 }, resume_uploads: { newer: 1 } } }))
      .toMatchObject({ content: older, rule: CONTENT_RULES.REVIEWED_ROW });
    expect(chooseContent([app('older', { resumeDecision: 'yes' }), newer]).rule).toBe(CONTENT_RULES.REVIEWED_ROW);
  });

  it('a. keeps the latest of several reviewed rows', () => {
    expect(chooseContent(ordered, { dependents: { comments: { older: 1, middle: 2 } } }))
      .toMatchObject({ content: middle, rule: CONTENT_RULES.LATEST_REVIEWED_ROW });
  });

  it('b. keeps the latest submission made before the first document score', () => {
    expect(chooseContent(ordered, { firstScoreAt: new Date('2026-09-23T00:00:00Z') }))
      .toMatchObject({ content: middle, rule: CONTENT_RULES.BEFORE_FIRST_SCORE });
  });

  it('b. keeps the oldest row when every submission came after the first score', () => {
    expect(chooseContent(ordered, { firstScoreAt: new Date('2026-09-01T00:00:00Z') }))
      .toMatchObject({ content: older, rule: CONTENT_RULES.OLDEST_ALL_AFTER_FIRST_SCORE });
  });

  it('c. keeps the latest submission when nothing has been reviewed', () => {
    expect(chooseContent(ordered, { dependents: { resume_uploads: {} } }))
      .toMatchObject({ content: newer, rule: CONTENT_RULES.LATEST_SUBMISSION });
  });
});

const seedGroup = (older = {}, newer = {}, extra = {}) => fakeDb({
  candidate: [candidateRow()],
  application: [app('older', older), app('newer', { submittedAt: LATE, ...newer })],
  ...extra
});

describe('mergeDuplicateApplications', () => {
  it('keeps the oldest row, with the latest submission\'s answers when nothing was reviewed', async () => {
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
    expect(summary).toMatchObject({ survivorId: 'older', contentFrom: 'newer', contentRule: CONTENT_RULES.LATEST_SUBMISSION });
  });

  it('keeps the answers a reviewer commented on, not the later resubmission', async () => {
    const { client, tables } = seedGroup({}, {}, { comment: [{ id: 'c-1', applicationId: 'older' }] });
    const summary = await mergeDuplicateApplications(client, { survivorId: 'older', loserIds: ['newer'] });

    expect(summary).toMatchObject({ contentFrom: 'older', contentRule: CONTENT_RULES.REVIEWED_ROW });
    expect(tables.application[0]).toMatchObject({ responseID: 'resp-older', resumeUrl: '/api/files/older-resume/pdf', supersededResponseIds: ['resp-newer'] });
  });

  it('keeps the version graders opened when only document scores exist', async () => {
    const { client, tables } = seedGroup({}, {}, {
      resumeScore: [{ id: 's', candidateId: 'cand-1', cycleId: 'cycle-1', createdAt: MIDDLE }]
    });
    const summary = await mergeDuplicateApplications(client, { survivorId: 'older', loserIds: ['newer'] });
    expect(summary).toMatchObject({ contentFrom: 'older', contentRule: CONTENT_RULES.BEFORE_FIRST_SCORE });
    expect(tables.application[0].resumeUrl).toBe('/api/files/older-resume/pdf');
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

  it('refuses a group where one row was submitted under another candidate\'s address', async () => {
    const { client, tables } = seedGroup({}, { email: 'Someone@g.ucla.edu' });
    tables.candidate.push({ id: 'cand-2', email: 'someone@ucla.edu', recordsLockedAt: null });

    await expect(mergeDuplicateApplications(client, { survivorId: 'older', loserIds: ['newer'] }))
      .rejects.toMatchObject({ code: MERGE_CONFLICTS.IDENTITY_CONFLICT });
    expect(tables.application).toHaveLength(2);
  });

  it('refuses when a client was assigned a resume whose answers would not be kept', async () => {
    const { client, tables } = seedGroup({}, {}, {
      clientResumeAssignment: [{ id: 'cra-1', applicationId: 'older', clientId: 'client-1', revokedAt: null }],
      comment: [{ id: 'c-1', applicationId: 'newer' }]
    });

    await expect(mergeDuplicateApplications(client, { survivorId: 'older', loserIds: ['newer'] }))
      .rejects.toMatchObject({ code: MERGE_CONFLICTS.CLIENT_RESUME });
    expect(tables.application).toHaveLength(2);
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
    // Both rows are reviewed (the newer one heavily), so the newer one's
    // answers are kept and its resume history and client assignment may move.
    extra.comment.push({ id: 'c-older', applicationId: 'older' });
    const { client, tables } = seedGroup({}, {}, extra);

    const summary = await mergeDuplicateApplications(client, { survivorId: 'older', loserIds: ['newer'] });

    expect(summary.contentRule).toBe(CONTENT_RULES.LATEST_REVIEWED_ROW);
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
  it('reports each duplicated candidate, oldest first, with the rule that chose the answers', async () => {
    const { client } = fakeDb({
      candidate: [candidateRow(), { id: 'cand-2', email: 'other@ucla.edu', recordsLockedAt: null }],
      application: [
        app('newer', { submittedAt: LATE }),
        app('older'),
        app('solo', { candidateId: 'cand-2', email: 'other@ucla.edu' })
      ],
      comment: [{ id: 'c-1', applicationId: 'newer' }]
    });

    const groups = await findDuplicateApplicationGroups(client, { cycleId: 'cycle-1' });

    expect(groups).toHaveLength(1);
    expect(groups[0].applications.map((a) => a.id)).toEqual(['older', 'newer']);
    expect(groups[0].dependents.comments).toEqual({ newer: 1 });
    expect(groups[0].plan).toMatchObject({
      survivorId: 'older', loserIds: ['newer'], contentFrom: 'newer', contentRule: CONTENT_RULES.REVIEWED_ROW, conflicts: []
    });
    for (const [args] of client.application.findMany.mock.calls) {
      expect(args.select).toBeDefined();
      expect(args.select).not.toHaveProperty('supersededResponseIds');
    }
  });
});
