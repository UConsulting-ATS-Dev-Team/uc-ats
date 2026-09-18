import { ROUND_FOR_INTERVIEW_TYPE } from './interviewRounds';

// The decision a reviewer records on a candidate after an interview.
//
// This list used to be copy-pasted into five pages, which is how the guide came
// about: nothing said what the options meant, and nothing stopped them drifting
// apart. The values are the InterviewDecision enum in schema.prisma and the
// colours are the class suffixes in the interview stylesheets.
//
// InterviewDecision also has UNSURE, which no picker has ever offered. It stays
// out of this list on purpose - see DECISION_VALUES in
// server/src/services/decisionGuides.js.
export const DECISION_OPTIONS = Object.freeze([
  Object.freeze({ value: 'YES', label: 'Yes', color: 'green' }),
  Object.freeze({ value: 'MAYBE_YES', label: 'Maybe-Yes', color: 'light-green' }),
  Object.freeze({ value: 'MAYBE_NO', label: 'Maybe-No', color: 'orange' }),
  Object.freeze({ value: 'NO', label: 'No', color: 'red' })
]);

/** The phase whose guide an interview of this type should show. */
const PHASE_FOR_ROUND = Object.freeze({ 2: 'coffee', 3: 'firstRound', 4: 'final' });

/**
 * Which decision guide applies to an interview.
 *
 * A deliberations interview has no round of its own - it draws from the whole
 * cycle - so it reads the shared 'general' guide, as does any type this map has
 * never heard of.
 */
export function guidePhaseForInterviewType(interviewType) {
  const round = ROUND_FOR_INTERVIEW_TYPE[interviewType]?.round;
  return PHASE_FOR_ROUND[round] || 'general';
}
