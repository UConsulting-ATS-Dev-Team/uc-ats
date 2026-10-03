import { describe, it, expect } from 'vitest';
import { ordinal, stepFromParam, stepToParam, walkthroughNeighbour, walkthroughPosition } from './reviewDelib';

describe('walkthroughPosition', () => {
  it('keeps the viewer where they are while their candidate is still listed', () => {
    expect(walkthroughPosition(['a', 'b', 'c'], ['a', 'b'], 'b')).toBe('b');
  });

  it('moves to the next candidate still listed, else the last, else none', () => {
    expect(walkthroughPosition(['a', 'b', 'c', 'd'], ['a', 'd'], 'b')).toBe('d');
    expect(walkthroughPosition(['a', 'b', 'c'], ['a'], 'c')).toBe('a');
    expect(walkthroughPosition(['a'], [], 'a')).toBe(null);
  });

  it('lands on the first candidate when the viewer was on none, as when an empty list fills', () => {
    expect(walkthroughPosition([], ['a', 'b'], null)).toBe('a');
    // A stale or mistyped id from the URL is the same as none.
    expect(walkthroughPosition(['a', 'b'], ['a', 'b'], 'zzz')).toBe('a');
  });

  it('never chooses a candidate that cannot be shown', () => {
    const canShow = (id) => id !== 'b';
    expect(walkthroughPosition([], ['b', 'c'], null, canShow)).toBe('c');
    expect(walkthroughPosition(['a', 'b', 'c'], ['b', 'c'], 'a', canShow)).toBe('c');
    // Sealed while being looked at: on to the next one.
    expect(walkthroughPosition(['a', 'b', 'c'], ['a', 'b', 'c'], 'b', canShow)).toBe('c');
    expect(walkthroughPosition(['b'], ['b'], null, canShow)).toBe(null);
  });
});

describe('walkthroughNeighbour', () => {
  const order = ['a', 'b', 'c', 'd'];
  const canShow = (id) => id !== 'c';

  it('steps over candidates that cannot be shown', () => {
    expect(walkthroughNeighbour(order, 'b', 1, canShow)).toBe('d');
    expect(walkthroughNeighbour(order, 'd', -1, canShow)).toBe('b');
  });

  it('stops at either end', () => {
    expect(walkthroughNeighbour(order, 'a', -1)).toBe(null);
    expect(walkthroughNeighbour(order, 'd', 1)).toBe(null);
  });

  it('starts from the first when the viewer is on none', () => {
    expect(walkthroughNeighbour(order, null, 1)).toBe('a');
    expect(walkthroughNeighbour(order, null, -1)).toBe(null);
  });
});

describe('step params', () => {
  it('round-trips, and reads anything unknown as the overview', () => {
    expect(stepFromParam(stepToParam('OUTLIERS'))).toBe('OUTLIERS');
    expect(stepFromParam('all')).toBe('ALL');
    expect(stepFromParam('nonsense')).toBe('OVERVIEW');
    expect(stepFromParam(null)).toBe('OVERVIEW');
  });
});

describe('ordinal', () => {
  it("reads like Staging's rank tooltip", () => {
    expect([1, 2, 3, 4, 11, 12, 13, 21, 112].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '11th', '12th', '13th', '21st', '112th']);
  });
});
