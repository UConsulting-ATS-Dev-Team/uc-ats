// The Staging pipeline, in order. Application.currentRound holds these strings,
// and ACCEPTED_ROUND marks someone who has passed the last one.
//
// Decision processing, the admin dashboard and the decision email copy all read
// the order from here, so adding or renaming a round happens in one place.

export const ROUNDS = Object.freeze([
  { round: '1', stage: 'RESUME_REVIEW', label: 'Resume Review', phase: 'resume', decisionField: 'resumeDecision' },
  { round: '2', stage: 'COFFEE_CHAT', label: 'Coffee Chats', phase: 'coffee', decisionField: 'coffeeChatDecision' },
  { round: '3', stage: 'FIRST_ROUND', label: 'First Round Interviews', phase: 'firstRound', decisionField: 'firstRoundDecision' },
  { round: '4', stage: 'FINAL_ROUND', label: 'Final Round Interviews', phase: 'final', decisionField: 'finalRoundDecision' }
]);

export const ACCEPTED_ROUND = '5';

export const getRound = (round) => ROUNDS.find((entry) => entry.round === String(round)) || null;

export const isFinalRound = (round) => String(round) === ROUNDS[ROUNDS.length - 1].round;

/** The round after `round`, or null when `round` is the last one or not a round at all. */
export function nextRound(round) {
  const index = ROUNDS.findIndex((entry) => entry.round === String(round));
  return index === -1 ? null : ROUNDS[index + 1] || null;
}
