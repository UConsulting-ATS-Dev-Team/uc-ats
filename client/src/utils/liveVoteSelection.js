// Pure helpers behind the live vote screens: choosing candidates on Staging and
// describing results.

export const DECISION_LABELS = Object.freeze({
  yes: 'Yes',
  maybe_yes: 'Maybe Yes',
  maybe_no: 'Maybe No',
  no: 'No'
});

export const DECISION_OPTIONS = Object.freeze(['yes', 'maybe_yes', 'maybe_no', 'no']);

export const DECISION_COLORS = Object.freeze({
  yes: 'success',
  maybe_yes: 'info',
  maybe_no: 'warning',
  no: 'error'
});

export const decisionLabel = (decision) => DECISION_LABELS[decision] || 'Pending';

const fullName = (candidate) => `${candidate.firstName || ''} ${candidate.lastName || ''}`.trim();

export function filterBySearch(candidates, query) {
  const needle = String(query || '').trim().toLowerCase();
  if (!needle) return candidates;
  return candidates.filter((candidate) =>
    [fullName(candidate), candidate.email, candidate.major, candidate.studentId]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle))
  );
}

// Maybes first, since those are what a deliberation is for; then settled
// decisions; undecided last.
const GROUP_ORDER = { maybe_yes: 0, maybe_no: 1, yes: 2, no: 3 };
const groupOf = (decision) => GROUP_ORDER[decision] ?? 4;

/** Voting order: by current decision group, then by name. */
export function sortForSession(candidates, decisions = {}) {
  return [...candidates].sort((a, b) =>
    groupOf(decisions[a.id]) - groupOf(decisions[b.id]) ||
    fullName(a).localeCompare(fullName(b))
  );
}

/** Ids of the candidates whose current decision is one of `values`, skipping locked rows. */
export function idsWithDecision(candidates, decisions = {}, values) {
  return candidates
    .filter((candidate) => !candidate.locked && values.includes(decisions[candidate.id]))
    .map((candidate) => candidate.id);
}

export const latestBallot = (ballots) => (ballots?.length ? ballots[ballots.length - 1] : null);

export function ballotTone({ yesCount = 0, noCount = 0 } = {}) {
  if (yesCount > noCount) return 'success';
  if (noCount > yesCount) return 'error';
  return 'default';
}

export function formatBallotLine(ballot) {
  const when = ballot.closedAt
    ? new Date(ballot.closedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
    : '';
  const decision = ballot.decisionApplied ? ` · Decision: ${decisionLabel(ballot.decisionApplied)}` : '';
  return `${when} · Round ${ballot.roundNumber} · ${ballot.yesCount} yes / ${ballot.noCount} no${decision}`;
}
