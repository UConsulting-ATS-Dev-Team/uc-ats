// Auto-distribute hands unassigned applicants to review teams. Each one goes to
// whichever team has the fewest right now, counting what it already holds, so a
// team that started with 5 catches up to one that started with 14 before either
// gets more. Ties go to the earlier team in `teams`, which keeps a run
// repeatable. Nothing already assigned is moved: graders may have started on it.

/**
 * @param {Array<{ id: string }>} teams in tie-break order
 * @param {Map<string, number>} currentCounts applicants each team already holds
 * @param {string[]} candidateIds unassigned applicants, in the order to hand out
 * @returns {Array<{ candidateId: string, teamId: string }>}
 */
export function planBalancedAssignments(teams, currentCounts, candidateIds) {
  if (teams.length === 0) return [];
  const load = teams.map((team) => ({ id: team.id, count: currentCounts.get(team.id) ?? 0 }));

  return candidateIds.map((candidateId) => {
    let target = load[0];
    for (const team of load) {
      if (team.count < target.count) target = team;
    }
    target.count += 1;
    return { candidateId, teamId: target.id };
  });
}

/** Applicants per team after a plan, for reporting. */
export function countsAfter(teams, currentCounts, assignments) {
  const counts = new Map(teams.map((team) => [team.id, currentCounts.get(team.id) ?? 0]));
  for (const { teamId } of assignments) counts.set(teamId, counts.get(teamId) + 1);
  return counts;
}
