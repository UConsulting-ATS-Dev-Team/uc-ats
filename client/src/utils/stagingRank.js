// Where each candidate stands on score within a Staging round.
//
// Ranked against everyone in the round, not against what is on screen, so #7
// still means seventh-best after filtering to one review team or sorting by
// name. Ties share a rank and the next one skips (1, 2, 2, 4), so a rank always
// says how many people scored strictly higher.
//
// A score of 0 is unranked. Staging reads a missing score as 0 (an ungraded
// application, or an interview with no evaluations yet), and a room full of
// people tied at last place says nothing.
export function rankByScore(ids, scoreOf) {
  const scored = ids
    .map((id) => ({ id, score: Number(scoreOf(id)) || 0 }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score);

  const ranks = new Map();
  scored.forEach((entry, index) => {
    const previous = scored[index - 1];
    ranks.set(entry.id, previous && previous.score === entry.score ? ranks.get(previous.id) : index + 1);
  });

  return { ranks, rankedCount: scored.length };
}
