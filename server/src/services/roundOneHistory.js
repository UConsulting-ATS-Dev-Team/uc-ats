import prisma from '../prismaClient.js';
import { groupIdForCandidate, expandGroupIdsForQuestions } from './interviewRoster.js';

// Read-only reconstruction of what one candidate was asked in round one, for a
// member writing questions for a later round. Nothing here writes, and nothing
// here is reachable from the round-one screens themselves.
//
// "What they were asked" is two lists, not one. Round one puts the same shared
// questions to everyone in a group (behavioral_questions rows with a groupId and
// a null applicationId) and then lets the interviewer add questions for that one
// candidate (the same table, applicationId set). Returning only the second list
// would hide most of the interview from the person trying not to repeat it, so
// both are returned, each tagged with its scope.
//
// What does not exist anywhere in the schema is the candidate's own answer. The
// only free text round one records is the evaluator's notes on each question, so
// that is what comes back, attributed to the evaluator who wrote it. Callers must
// not present it as a transcript.

const QUESTION_SCOPE = { SHARED: 'SHARED', CANDIDATE: 'CANDIDATE' };

// behavioralNotes is a JSON object keyed by behavioral_questions.id, stored as a
// string. Bad JSON means notes we cannot key - drop them rather than fail the
// whole history, which would blank the panel over one malformed row.
const parseNotes = (raw) => {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
};

const serializeQuestion = (row, scope) => ({
  id: row.id,
  text: row.questionText,
  order: row.order,
  scope
});

const byOrderThenCreated = [{ order: 'asc' }, { createdAt: 'asc' }];

/**
 * The round-one interviews this application actually has a record in. An
 * evaluation is the usual signal, but questions can be written for a candidate
 * before anyone submits an evaluation, so both are counted. interviewType is
 * checked rather than assumed: candidate-scoped questions are only creatable on
 * ROUND_ONE today, and this keeps that true if that ever changes.
 */
async function roundOneInterviewIdsFor(applicationId, client) {
  const [evaluated, questioned] = await Promise.all([
    client.firstRoundInterviewEvaluation.findMany({
      where: { applicationId },
      select: { interviewId: true },
      distinct: ['interviewId']
    }),
    client.behavioralQuestion.findMany({
      where: { applicationId },
      select: { interviewId: true },
      distinct: ['interviewId']
    })
  ]);

  const ids = [...new Set([...evaluated, ...questioned].map((row) => row.interviewId))];
  if (ids.length === 0) return [];

  const interviews = await client.interview.findMany({
    where: { id: { in: ids }, interviewType: 'ROUND_ONE' },
    select: { id: true, title: true, interviewType: true, startDate: true, endDate: true },
    orderBy: { startDate: 'asc' }
  });
  return interviews;
}

/** Shared questions put to the group this candidate sat in, if it can be resolved. */
async function sharedQuestionsFor(interviewId, applicationId, client) {
  const groupId = await groupIdForCandidate(interviewId, applicationId, client);
  if (!groupId) return [];

  // Questions written before the roster moved into real tables are keyed on the
  // old group id; reading one key alone drops half a group's list.
  const groupIds = await expandGroupIdsForQuestions(interviewId, [groupId], client);
  if (groupIds.length === 0) return [];

  const rows = await client.behavioralQuestion.findMany({
    where: { interviewId, groupId: { in: groupIds }, applicationId: null },
    orderBy: byOrderThenCreated
  });
  return rows.map((row) => serializeQuestion(row, QUESTION_SCOPE.SHARED));
}

async function candidateQuestionsFor(interviewId, applicationId, client) {
  const rows = await client.behavioralQuestion.findMany({
    where: { interviewId, applicationId },
    orderBy: byOrderThenCreated
  });
  return rows.map((row) => serializeQuestion(row, QUESTION_SCOPE.CANDIDATE));
}

async function evaluatorsFor(interviewId, applicationId, client) {
  const evaluations = await client.firstRoundInterviewEvaluation.findMany({
    where: { interviewId, applicationId },
    include: {
      evaluator: { select: { id: true, fullName: true, email: true } }
    },
    orderBy: { createdAt: 'asc' }
  });

  return evaluations.map((evaluation) => ({
    evaluationId: evaluation.id,
    evaluatorId: evaluation.evaluatorId,
    // fullName is nullable on User; the email is a worse label but a better one
    // than an empty attribution on someone else's notes.
    evaluatorName: evaluation.evaluator?.fullName || evaluation.evaluator?.email || 'Unknown evaluator',
    decision: evaluation.decision,
    notesByQuestionId: parseNotes(evaluation.behavioralNotes),
    marketSizingNotes: evaluation.marketSizingNotes || null,
    additionalNotes: evaluation.additionalNotes || null,
    submittedAt: evaluation.updatedAt
  }));
}

/**
 * Round-one questions and evaluator notes for one application.
 * Always resolves; an application with no round-one record returns an empty
 * `interviews` list rather than throwing, so the caller can say "no round one
 * on record" instead of treating it as a failure.
 */
export async function getRoundOneHistory(applicationId, client = prisma) {
  if (!applicationId) return { applicationId: null, interviews: [] };

  const interviews = await roundOneInterviewIdsFor(applicationId, client);
  if (interviews.length === 0) return { applicationId, interviews: [] };

  const hydrated = await Promise.all(
    interviews.map(async (interview) => {
      const [shared, candidate, evaluators] = await Promise.all([
        sharedQuestionsFor(interview.id, applicationId, client),
        candidateQuestionsFor(interview.id, applicationId, client),
        evaluatorsFor(interview.id, applicationId, client)
      ]);

      return {
        interviewId: interview.id,
        title: interview.title,
        interviewType: interview.interviewType,
        startDate: interview.startDate,
        endDate: interview.endDate,
        // Shared first, then this candidate's own - the order they were asked in.
        questions: [...shared, ...candidate],
        evaluators
      };
    })
  );

  // An interview with neither questions nor notes tells the reader nothing and
  // reads as a bug; leave it out so "no round one on record" stays honest.
  const substantive = hydrated.filter(
    (interview) => interview.questions.length > 0 || interview.evaluators.length > 0
  );

  return { applicationId, interviews: substantive };
}

export { QUESTION_SCOPE };
