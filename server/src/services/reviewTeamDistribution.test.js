import { describe, it, expect } from 'vitest';
import { planBalancedAssignments, countsAfter, planRebalance } from './reviewTeamDistribution.js';

const teams = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
const ids = (n) => Array.from({ length: n }, (_, i) => `cand-${i + 1}`);

describe('planBalancedAssignments', () => {
  it('fills the smallest team first when teams start uneven', () => {
    const current = new Map([['a', 14], ['b', 5], ['c', 5]]);
    const plan = planBalancedAssignments(teams, current, ids(10));

    expect(plan.every(({ teamId }) => teamId !== 'a')).toBe(true);
    expect(countsAfter(teams, current, plan)).toEqual(new Map([['a', 14], ['b', 10], ['c', 10]]));
  });

  it('evens the teams out once the smaller ones catch up', () => {
    const current = new Map([['a', 14], ['b', 5]]);
    const plan = planBalancedAssignments(teams.slice(0, 2), current, ids(13));

    // 9 bring b level with a, then the last 4 alternate.
    expect(countsAfter(teams.slice(0, 2), current, plan)).toEqual(new Map([['a', 16], ['b', 16]]));
  });

  it('never leaves teams more than one apart when there are enough applications', () => {
    const current = new Map([['a', 3], ['b', 0], ['c', 7]]);
    const after = countsAfter(teams, current, planBalancedAssignments(teams, current, ids(20)));
    const counts = [...after.values()];
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(counts.reduce((sum, n) => sum + n, 0)).toBe(30);
  });

  it('treats a team with no applications as zero', () => {
    const plan = planBalancedAssignments(teams, new Map([['a', 2], ['b', 2]]), ids(2));
    expect(plan.map(({ teamId }) => teamId)).toEqual(['c', 'c']);
  });

  it('breaks ties by team order, so the same input gives the same plan', () => {
    const plan = planBalancedAssignments(teams, new Map(), ids(4));
    expect(plan.map(({ teamId }) => teamId)).toEqual(['a', 'b', 'c', 'a']);
  });

  it('assigns nothing without teams', () => {
    expect(planBalancedAssignments([], new Map(), ids(3))).toEqual([]);
  });
});

describe('planRebalance', () => {
  const unscored = (prefix, n) => Array.from({ length: n }, (_, i) => `${prefix}-${i + 1}`);
  const finalCounts = (teams, plan) => {
    const counts = new Map(teams.map((t) => [t.id, t.scored + t.unscored.length]));
    for (const { from, to } of plan.moves) {
      if (from) counts.set(from, counts.get(from) - 1);
      counts.set(to, counts.get(to) + 1);
    }
    return counts;
  };

  it('evens out 14 and 5 when nothing is scored, moving as few as possible', () => {
    const teams = [
      { id: 'big', scored: 0, unscored: unscored('big', 14) },
      { id: 'small', scored: 0, unscored: unscored('small', 5) },
    ];
    const plan = planRebalance(teams);

    expect(finalCounts(teams, plan)).toEqual(new Map([['big', 10], ['small', 9]]));
    expect(plan.moves).toHaveLength(4);
    expect(plan.moves.every((m) => m.from === 'big' && m.to === 'small')).toBe(true);
    // The last ones listed are the ones that move.
    expect(plan.moves.map((m) => m.candidateId)).toEqual(['big-11', 'big-12', 'big-13', 'big-14']);
  });

  it('never moves a scored applicant, so a mostly-graded team stays high', () => {
    const teams = [
      { id: 'graded', scored: 12, unscored: unscored('g', 2) },
      { id: 'small', scored: 0, unscored: unscored('s', 2) },
    ];
    const plan = planRebalance(teams);

    expect(finalCounts(teams, plan)).toEqual(new Map([['graded', 12], ['small', 4]]));
    expect(plan.moves.every((m) => m.from === 'graded')).toBe(true);
  });

  it('places unassigned applicants as part of the same balance', () => {
    const teams = [
      { id: 'a', scored: 3, unscored: [] },
      { id: 'b', scored: 0, unscored: unscored('b', 1) },
    ];
    const plan = planRebalance(teams, ['new-1', 'new-2', 'new-3']);

    expect(finalCounts(teams, plan)).toEqual(new Map([['a', 4], ['b', 3]]));
    expect(plan.moves.every((m) => m.from === null)).toBe(true);
  });

  it('moves nobody when teams are already within one', () => {
    const teams = [
      { id: 'a', scored: 2, unscored: unscored('a', 3) },
      { id: 'b', scored: 0, unscored: unscored('b', 4) },
      { id: 'c', scored: 1, unscored: unscored('c', 4) },
    ];
    expect(planRebalance(teams).moves).toEqual([]);
  });

  it('keeps every team within one when scores allow it', () => {
    const teams = [
      { id: 'a', scored: 4, unscored: unscored('a', 10) },
      { id: 'b', scored: 1, unscored: unscored('b', 4) },
      { id: 'c', scored: 0, unscored: [] },
      { id: 'd', scored: 2, unscored: unscored('d', 1) },
    ];
    const counts = [...finalCounts(teams, planRebalance(teams, ['x'])).values()];
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
    expect(counts.reduce((s, n) => s + n, 0)).toBe(23);
  });
});
