// Which pipeline round an interview belongs to.
//
// Two vocabularies describe the same pipeline and do not agree:
//
//   ROUNDS[].stage   RESUME_REVIEW  COFFEE_CHAT  FIRST_ROUND  FINAL_ROUND
//   InterviewType    -              COFFEE_CHAT  ROUND_ONE    FINAL_ROUND / ROUND_TWO
//
// FIRST_ROUND and ROUND_ONE are the same round under two names, and ROUND_TWO is
// a legacy alias of FINAL_ROUND that was never migrated out of the enum. Until
// this commit the only translation between them lived in the client
// (client/src/utils/interviewRounds.js), so the server had no way to answer "which
// interview should a candidate in round 3 sign up for" - which candidate
// eligibility, the roster resolver and the decision-email scheduling link all need.
//
// The mapping is deliberately offset by one relative to intuition: a COFFEE_CHAT
// interview draws candidates whose Application.currentRound is '2', because
// currentRound is the round a candidate is *sitting in*, and passing resume review
// is what puts them into the coffee chat round.
//
// Rounds themselves are not redefined here - they are derived from ROUNDS, so
// adding a round stays the one-file change roundProgression.js promises.

import { ROUNDS } from './roundProgression.js';

/**
 * InterviewType -> the ROUNDS stage it runs. Null means the type has no round of
 * its own: deliberations happen inside a round rather than being one.
 *
 * Every InterviewType value must appear here. interviewRounds.test.js enumerates
 * the enum and fails if one is missing, so adding a type forces a decision rather
 * than silently mapping to undefined.
 */
const STAGE_FOR_INTERVIEW_TYPE = Object.freeze({
  COFFEE_CHAT: 'COFFEE_CHAT',
  ROUND_ONE: 'FIRST_ROUND',
  ROUND_TWO: 'FINAL_ROUND',
  FINAL_ROUND: 'FINAL_ROUND',
  DELIBERATIONS: null,
});

const roundByStage = new Map(ROUNDS.map((entry) => [entry.stage, entry]));

/**
 * The ROUNDS entry an interview of this type draws its candidates from, or null
 * for a type with no round of its own or one this map has never heard of.
 */
export function roundForInterviewType(interviewType) {
  const stage = STAGE_FOR_INTERVIEW_TYPE[interviewType];
  if (!stage) return null;
  return roundByStage.get(stage) || null;
}

/** Just the round string ('2', '3', ...), or null. */
export const roundNumberForInterviewType = (interviewType) =>
  roundForInterviewType(interviewType)?.round ?? null;

/**
 * Every InterviewType that serves this round. FINAL_ROUND and its legacy alias
 * ROUND_TWO both serve round '4', so this returns a list rather than one value -
 * a query for "the interviews a round-4 candidate books" must match both.
 */
export function interviewTypesForRound(round) {
  const wanted = String(round);
  return Object.keys(STAGE_FOR_INTERVIEW_TYPE).filter(
    (type) => roundForInterviewType(type)?.round === wanted
  );
}

/** Whether a candidate sitting in `currentRound` belongs in this interview. */
export const isCandidateEligibleForInterview = (currentRound, interviewType) => {
  const mapped = roundForInterviewType(interviewType);
  return mapped ? String(currentRound) === mapped.round : false;
};

export { STAGE_FOR_INTERVIEW_TYPE };
