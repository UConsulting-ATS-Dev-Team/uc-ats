// Which pipeline round an interview draws its candidates from.
//
// Application.currentRound holds the round strings defined in
// server/src/utils/roundProgression.js: '1' Resume Review, '2' Coffee Chats,
// '3' First Round, '4' Final Round ('5' means accepted). ROUND_TWO is the
// legacy alias of FINAL_ROUND, matching how the rest of the app treats it.
export const ROUND_FOR_INTERVIEW_TYPE = Object.freeze({
  COFFEE_CHAT: { round: '2', label: 'Coffee Chat Round' },
  ROUND_ONE: { round: '3', label: 'First Round' },
  ROUND_TWO: { round: '4', label: 'Final Round' },
  FINAL_ROUND: { round: '4', label: 'Final Round' },
});

/** Heading for the application picker, e.g. "First Round Applications:". */
export function roundLabelForInterview(interviewType) {
  const mapped = ROUND_FOR_INTERVIEW_TYPE[interviewType];
  return mapped ? `${mapped.label} Applications:` : 'Applications:';
}

/** Empty-state copy that names the round the picker is looking at. */
export function emptyRoundMessage(interviewType) {
  const mapped = ROUND_FOR_INTERVIEW_TYPE[interviewType];
  return mapped ? `No applications in ${mapped.label.toLowerCase()}` : 'No applications in this cycle';
}

/**
 * The candidates an interview of this type should offer. Types with no round of
 * their own (deliberations, or an unrecognised type) get the whole cycle rather
 * than an empty list, so the picker is never silently unusable.
 */
export function applicationsForInterview(applications, interviewType) {
  const list = Array.isArray(applications) ? applications : [];
  const mapped = ROUND_FOR_INTERVIEW_TYPE[interviewType];
  if (!mapped) return list;
  return list.filter((application) => String(application?.currentRound) === mapped.round);
}
