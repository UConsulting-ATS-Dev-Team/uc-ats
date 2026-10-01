import { describe, it, expect } from 'vitest';
import { planBalancedAssignments, countsAfter } from './reviewTeamDistribution.js';

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
