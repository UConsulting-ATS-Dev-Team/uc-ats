// Where each candidate stands on score within a Staging round.
//
// Ranked against everyone in the round, not against what is on screen, so #7
// still means seventh-best after filtering to one review team or sorting by
// name. Ties share a rank and the next one skips (1, 2, 2, 4), so a rank always
// says how many people scored strictly higher.
//
// A missing score (null or undefined) is unranked: no grades yet, or no
// interview evaluations. Zero is a real score - an interview where everyone
// said No averages to 0 - and ranks like any other.
export function rankByScore(ids, scoreOf) {
  const scored = ids
    .map((id) => ({ id, score: scoreOf(id) }))
    .filter((entry) => typeof entry.score === 'number' && Number.isFinite(entry.score))
    .sort((a, b) => b.score - a.score);

  const ranks = new Map();
  scored.forEach((entry, index) => {
    const previous = scored[index - 1];
    ranks.set(entry.id, previous && previous.score === entry.score ? ranks.get(previous.id) : index + 1);
  });

  return { ranks, rankedCount: scored.length };
}
