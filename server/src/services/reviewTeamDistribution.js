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

/**
 * Evens out teams that already hold applicants, moving only those nobody has
 * scored yet. A scored applicant stays put, so a team can end up above the
 * others if most of what it holds is already graded.
 *
 * Each team ends within one of the others where the scored applicants allow,
 * and as few people move as possible: a team keeps its own unscored applicants
 * up to its target, and the odd extras go to teams that already hold more.
 *
 * @param {Array<{ id: string, scored: number, unscored: string[] }>} teams in tie-break order;
 *   `unscored` lists candidate ids, the ones to move first last
 * @param {string[]} unassigned candidate ids on no team this cycle
 * @returns {{ moves: Array<{ candidateId: string, from: string|null, to: string }>,
 *             targets: Map<string, number> }}
 */
export function planRebalance(teams, unassigned = []) {
  if (teams.length === 0) return { moves: [], targets: new Map() };

  const pool = unassigned.length + teams.reduce((sum, team) => sum + team.unscored.length, 0);
  const level = teams.map((team, order) => ({
    id: team.id,
    order,
    count: team.scored,
    holds: team.scored + team.unscored.length
  }));
  for (let i = 0; i < pool; i++) {
    let target = level[0];
    for (const team of level) {
      if (
        team.count < target.count ||
        (team.count === target.count && team.holds > target.holds)
      ) target = team;
    }
    target.count += 1;
  }
  const targets = new Map(level.map((team) => [team.id, team.count]));

  const moving = unassigned.map((candidateId) => ({ candidateId, from: null }));
  const room = [];
  for (const team of teams) {
    const keep = Math.max(0, targets.get(team.id) - team.scored);
    for (const candidateId of team.unscored.slice(keep)) moving.push({ candidateId, from: team.id });
    for (let i = team.unscored.length; i < keep; i++) room.push(team.id);
  }

  return {
    moves: moving.map((move, i) => ({ ...move, to: room[i] })),
    targets
  };
}

/** Applicants per team after a plan, for reporting. */
export function countsAfter(teams, currentCounts, assignments) {
  const counts = new Map(teams.map((team) => [team.id, currentCounts.get(team.id) ?? 0]));
  for (const { teamId } of assignments) counts.set(teamId, counts.get(teamId) + 1);
  return counts;
}
