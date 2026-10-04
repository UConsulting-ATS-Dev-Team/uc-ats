// What saving an interview evaluation writes, for both tables an evaluation lives in:
// FirstRoundInterviewEvaluation (ROUND_ONE) and InterviewEvaluation (every other round).
//
// A save writes only the fields the request carries. Evaluations are saved from more
// than one place: the interview pages send everything they show, but My Interviews'
// Edit Evaluation sends just { decision, notes }. Writing every field regardless set
// whatever was missing to null, so changing a decision there erased the interview's
// behavioral notes, case notes and candidate-details checklist.
//
// First round's post-grading notes arrive as `notes` (from the first round page and
// from Edit Evaluation alike) but are stored in `additionalNotes`, the only notes
// column that table has. They are handed back as `notes` on read, so the pages see the
// field they wrote. Before this they were dropped on every save.

const FIRST_ROUND_FIELDS = [
  'decision',
  'behavioralLeadership',
  'behavioralProblemSolving',
  'behavioralInterest',
  'behavioralTotal',
  'marketSizingTeamwork',
  'marketSizingLogic',
  'marketSizingCreativity',
  'marketSizingTotal',
  'marketSizingNotes',
  'additionalNotes',
];
const FIRST_ROUND_JSON_FIELDS = ['behavioralNotes'];

const STANDARD_FIELDS = ['decision', 'notes'];
const STANDARD_JSON_FIELDS = ['behavioralNotes', 'casingNotes', 'candidateDetails'];

// The JSON columns are stored as strings. An empty value is stored as null, as before.
const asJsonColumn = (value) => {
  if (!value) return null;
  return typeof value === 'string' ? value : JSON.stringify(value);
};

function pick(body, fields, jsonFields) {
  const data = {};
  for (const field of fields) {
    if (body[field] !== undefined) data[field] = body[field];
  }
  for (const field of jsonFields) {
    if (body[field] !== undefined) data[field] = asJsonColumn(body[field]);
  }
  return data;
}

/** The FirstRoundInterviewEvaluation columns a save writes, from the request body. */
export function firstRoundEvaluationWrite(body = {}) {
  const data = pick(body, FIRST_ROUND_FIELDS, FIRST_ROUND_JSON_FIELDS);
  if (data.additionalNotes === undefined && body.notes !== undefined) data.additionalNotes = body.notes;
  return data;
}

/** The InterviewEvaluation columns a save writes, from the request body. */
export function interviewEvaluationWrite(body = {}) {
  return pick(body, STANDARD_FIELDS, STANDARD_JSON_FIELDS);
}

// One evaluation per (interview, application, evaluator), enforced by a unique index on
// both tables. Saving used to read that row and then create it if missing, so two saves
// of a new evaluation arriving together (an autosave and Save, or an autosave and a slow
// earlier one) both read nothing, and the second create failed on the index with a 500.
// An upsert on the unique key is a single INSERT ... ON CONFLICT, so it cannot.
//
// Prisma only issues the native ON CONFLICT when the where and create agree on the key,
// which they do here; the P2002 retry covers a client that ever falls back to its
// read-then-write emulation. Retrying once is enough: after a conflict the row exists.
const isUniqueViolation = (error) => error?.code === 'P2002';

/**
 * Write the evaluation `evaluatorId` is saving for `applicationId` in `interview`,
 * creating it on the first save. Returns the row. First round evaluations come back
 * as stored; callers read them through readFirstRoundEvaluation when they need `notes`.
 */
export async function saveInterviewEvaluation(prisma, { interview, applicationId, evaluatorId, body }) {
  const firstRound = interview.interviewType === 'ROUND_ONE';
  const model = firstRound ? prisma.firstRoundInterviewEvaluation : prisma.interviewEvaluation;
  const data = {
    ...(firstRound ? firstRoundEvaluationWrite(body) : interviewEvaluationWrite(body)),
    updatedAt: new Date(),
  };
  const key = { interviewId: interview.id, applicationId, evaluatorId };
  const upsert = () => model.upsert({
    where: { interviewId_applicationId_evaluatorId: key },
    update: data,
    create: { ...key, ...data },
  });

  try {
    return await upsert();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    return upsert();
  }
}

/** A first round evaluation as the pages read it: post-grading notes under `notes`. */
export function readFirstRoundEvaluation(row) {
  if (!row) return row;
  return { ...row, notes: row.additionalNotes ?? '' };
}
