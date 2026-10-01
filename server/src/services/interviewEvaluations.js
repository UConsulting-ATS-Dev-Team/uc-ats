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

/** A first round evaluation as the pages read it: post-grading notes under `notes`. */
export function readFirstRoundEvaluation(row) {
  if (!row) return row;
  return { ...row, notes: row.additionalNotes ?? '' };
}
