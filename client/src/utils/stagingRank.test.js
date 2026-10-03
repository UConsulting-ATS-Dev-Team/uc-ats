import { describe, expect, it } from 'vitest';
import { rankByScore } from './stagingRank';

const scores = { a: 20.3, b: 19.7, c: 19.7, d: 19.5, e: 0, f: undefined };
const scoreOf = (id) => scores[id];

describe('rankByScore', () => {
  it('ranks highest first, ties share a rank and the next one skips', () => {
    const { ranks } = rankByScore(['d', 'c', 'a', 'b'], scoreOf);
    expect(Object.fromEntries(ranks)).toEqual({ a: 1, b: 2, c: 2, d: 4 });
  });

  it('leaves a zero or missing score unranked and does not count it', () => {
    const { ranks, rankedCount } = rankByScore(['a', 'e', 'f'], scoreOf);
    expect(ranks.has('e')).toBe(false);
    expect(ranks.has('f')).toBe(false);
    expect(rankedCount).toBe(1);
  });

  it('does not depend on input order', () => {
    const forward = rankByScore(['a', 'b', 'c', 'd'], scoreOf).ranks;
    const backward = rankByScore(['d', 'c', 'b', 'a'], scoreOf).ranks;
    expect(Object.fromEntries(backward)).toEqual(Object.fromEntries(forward));
  });
});
