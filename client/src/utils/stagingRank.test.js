import { describe, expect, it } from 'vitest';
import { rankByScore } from './stagingRank';

const scores = { a: 20.3, b: 19.7, c: 19.7, d: 19.5, z: 0, n: null, u: undefined };
const scoreOf = (id) => scores[id];

describe('rankByScore', () => {
  it('ranks highest first, ties share a rank and the next one skips', () => {
    const { ranks } = rankByScore(['d', 'c', 'a', 'b'], scoreOf);
    expect(Object.fromEntries(ranks)).toEqual({ a: 1, b: 2, c: 2, d: 4 });
  });

  it('ranks a real zero last instead of treating it as unscored', () => {
    const { ranks, rankedCount } = rankByScore(['a', 'z'], scoreOf);
    expect(ranks.get('z')).toBe(2);
    expect(rankedCount).toBe(2);
  });

  it('leaves a missing score unranked and does not count it', () => {
    const { ranks, rankedCount } = rankByScore(['a', 'n', 'u'], scoreOf);
    expect(ranks.has('n')).toBe(false);
    expect(ranks.has('u')).toBe(false);
    expect(rankedCount).toBe(1);
  });

  it('does not depend on input order', () => {
    const forward = rankByScore(['a', 'b', 'c', 'd', 'z'], scoreOf).ranks;
    const backward = rankByScore(['z', 'd', 'c', 'b', 'a'], scoreOf).ranks;
    expect(Object.fromEntries(backward)).toEqual(Object.fromEntries(forward));
  });
});
