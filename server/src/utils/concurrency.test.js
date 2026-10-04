import { describe, it, expect } from 'vitest';
import { mapWithConcurrency } from './concurrency.js';

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('mapWithConcurrency', () => {
  it('never has more than the limit in flight, and reaches it', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency(
      Array.from({ length: 10 }, (_, i) => i),
      async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await tick(2);
        inFlight -= 1;
      },
      3
    );
    expect(peak).toBe(3);
  });

  it('returns results in input order, whatever order they finish in', async () => {
    const results = await mapWithConcurrency([30, 1, 15, 5], async (ms) => {
      await tick(ms);
      return ms * 2;
    });
    expect(results).toEqual([60, 2, 30, 10]);
  });

  it('resolves to an empty list for empty input without calling fn', async () => {
    let calls = 0;
    expect(await mapWithConcurrency([], async () => { calls += 1; })).toEqual([]);
    expect(calls).toBe(0);
  });
});
