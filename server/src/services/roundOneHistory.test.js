// The panel this feeds exists so a final-round interviewer does not ask a
// question the candidate already answered in round one. That only works if both
// question lists come back - the shared list the whole group was asked and the
// one written for this candidate - and if the notes stay attached to the
// evaluator who wrote them.
import { describe, it, expect, vi } from 'vitest';

// Only here to stop the shared client connecting on import; every test below
// injects its own reader.
vi.mock('../prismaClient.js', () => ({ default: {} }));

import { getRoundOneHistory } from './roundOneHistory.js';

const APPLICATION = 'app-1';
const R1 = 'int-r1';

const question = (id, overrides = {}) => ({
  id,
  questionText: `Question ${id}`,
  order: 0,
  applicationId: null,
  groupId: 'grp-1',
  interviewId: R1,
  createdAt: new Date('2026-03-01T00:00:00.000Z'),
  ...overrides
});

const evaluation = (id, overrides = {}) => ({
  id,
  interviewId: R1,
  applicationId: APPLICATION,
  evaluatorId: `${id}-user`,
  decision: 'YES',
  behavioralNotes: null,
  marketSizingNotes: null,
  additionalNotes: null,
  createdAt: new Date('2026-03-01T00:00:00.000Z'),
  updatedAt: new Date('2026-03-02T00:00:00.000Z'),
  evaluator: { id: `${id}-user`, fullName: `Evaluator ${id}`, email: `${id}@uc.org` },
  ...overrides
});

/**
 * A prisma stand-in driven by plain fixtures. The service only ever reads, so
 * the fake dispatches on the shape of each `where` rather than modelling a db.
 */
const fakeClient = ({
  evaluations = [],
  sharedQuestions = [],
  candidateQuestions = [],
  interviews = [{ id: R1, title: 'Round One', interviewType: 'ROUND_ONE', startDate: new Date('2026-03-01T00:00:00.000Z'), endDate: null }],
  signupGroupId = 'grp-1',
  slots = []
} = {}) => ({
  firstRoundInterviewEvaluation: {
    findMany: async ({ where }) =>
      evaluations.filter((e) => !where.interviewId || e.interviewId === where.interviewId)
  },
  behavioralQuestion: {
    findMany: async ({ where }) => {
      // Discovery pass: which interviews did this candidate get questions in.
      if (where.applicationId && !where.interviewId) return candidateQuestions;
      if (where.applicationId === null) return sharedQuestions;
      if (where.applicationId) return candidateQuestions;
      return [];
    }
  },
  interview: {
    findMany: async () => interviews,
    findUnique: async () => ({ description: null })
  },
  interviewSlotSignup: {
    findFirst: async () => (signupGroupId ? { slot: { id: signupGroupId, legacyGroupId: null } } : null)
  },
  interviewSlot: {
    findMany: async () => slots
  }
});

describe('getRoundOneHistory', () => {
  it('returns both the shared questions and the ones written for this candidate', async () => {
    const client = fakeClient({
      evaluations: [evaluation('e1')],
      sharedQuestions: [question('q-shared-1'), question('q-shared-2')],
      candidateQuestions: [question('q-own-1', { applicationId: APPLICATION })]
    });

    const history = await getRoundOneHistory(APPLICATION, client);

    expect(history.interviews).toHaveLength(1);
    expect(history.interviews[0].questions.map((q) => [q.id, q.scope])).toEqual([
      ['q-shared-1', 'SHARED'],
      ['q-shared-2', 'SHARED'],
      ['q-own-1', 'CANDIDATE']
    ]);
  });

  it('attributes each note to the evaluator who wrote it', async () => {
    const client = fakeClient({
      evaluations: [
        evaluation('e1', {
          evaluatorId: 'u1',
          evaluator: { id: 'u1', fullName: 'Dana', email: 'd@uc.org' },
          behavioralNotes: JSON.stringify({ 'q-shared-1': 'Concrete example, well structured.' })
        }),
        evaluation('e2', {
          evaluatorId: 'u2',
          evaluator: { id: 'u2', fullName: 'Rae', email: 'r@uc.org' },
          behavioralNotes: JSON.stringify({ 'q-shared-1': 'Rambled before landing it.' })
        })
      ],
      sharedQuestions: [question('q-shared-1')]
    });

    const { evaluators } = (await getRoundOneHistory(APPLICATION, client)).interviews[0];

    expect(evaluators).toHaveLength(2);
    expect(evaluators.map((e) => [e.evaluatorName, e.notesByQuestionId['q-shared-1']])).toEqual([
      ['Dana', 'Concrete example, well structured.'],
      ['Rae', 'Rambled before landing it.']
    ]);
  });

  it('falls back to the email when an evaluator has no name, rather than dropping the attribution', async () => {
    const client = fakeClient({
      evaluations: [
        evaluation('e1', { evaluator: { id: 'u1', fullName: null, email: 'nameless@uc.org' } })
      ],
      sharedQuestions: [question('q-shared-1')]
    });

    const { evaluators } = (await getRoundOneHistory(APPLICATION, client)).interviews[0];

    expect(evaluators[0].evaluatorName).toBe('nameless@uc.org');
  });

  it('survives malformed behavioralNotes instead of blanking the whole panel', async () => {
    const client = fakeClient({
      evaluations: [evaluation('e1', { behavioralNotes: 'not json{' })],
      sharedQuestions: [question('q-shared-1')]
    });

    const history = await getRoundOneHistory(APPLICATION, client);

    expect(history.interviews[0].evaluators[0].notesByQuestionId).toEqual({});
    expect(history.interviews[0].questions).toHaveLength(1);
  });

  it('returns an empty list, not an error, when there is no round one on record', async () => {
    const client = fakeClient({ evaluations: [], interviews: [] });

    await expect(getRoundOneHistory(APPLICATION, client)).resolves.toEqual({
      applicationId: APPLICATION,
      interviews: []
    });
  });

  it('ignores interviews that are not round one', async () => {
    const client = fakeClient({
      evaluations: [evaluation('e1')],
      sharedQuestions: [question('q-shared-1')],
      // The interviewType filter is applied in the query; an empty result stands
      // in for "the only linked interview was a later round".
      interviews: []
    });

    const history = await getRoundOneHistory(APPLICATION, client);

    expect(history.interviews).toEqual([]);
  });

  it('still returns questions when the candidate has questions but no submitted evaluation', async () => {
    const client = fakeClient({
      evaluations: [],
      sharedQuestions: [],
      candidateQuestions: [question('q-own-1', { applicationId: APPLICATION })]
    });

    const history = await getRoundOneHistory(APPLICATION, client);

    expect(history.interviews[0].questions.map((q) => q.id)).toEqual(['q-own-1']);
    expect(history.interviews[0].evaluators).toEqual([]);
  });

  it('drops the shared list when the candidate cannot be placed in a group, keeping their own questions', async () => {
    const client = fakeClient({
      evaluations: [evaluation('e1')],
      sharedQuestions: [question('q-shared-1')],
      candidateQuestions: [question('q-own-1', { applicationId: APPLICATION })],
      signupGroupId: null
    });

    const history = await getRoundOneHistory(APPLICATION, client);

    expect(history.interviews[0].questions.map((q) => q.id)).toEqual(['q-own-1']);
  });

  it('returns an empty shape for a missing application id', async () => {
    await expect(getRoundOneHistory(null, fakeClient())).resolves.toEqual({
      applicationId: null,
      interviews: []
    });
  });
});
