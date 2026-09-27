import { describe, it, expect, vi, beforeEach } from 'vitest';

import { computeDayAggregates, percentile } from './aggregate.js';
import { dayBounds, daysToRollUp, laDay, pruneRaw, rollupDay, runRollup, shiftDay } from './rollup.js';

vi.mock('../../prismaClient.js', () => ({ default: {} }));
vi.mock('./aggregate.js', async (importOriginal) => ({
  ...(await importOriginal()),
  computeDayAggregates: vi.fn(),
}));

const fakeClient = () => {
  const client = {
    analyticsDailySummary: {
      deleteMany: vi.fn((a) => ({ op: 'delS', a })),
      createMany: vi.fn((a) => ({ op: 'addS', a })),
      findFirst: vi.fn(async () => null),
    },
    analyticsDailyFact: { deleteMany: vi.fn((a) => ({ op: 'delF', a })), createMany: vi.fn((a) => ({ op: 'addF', a })) },
    $transaction: vi.fn(async (ops) => ops),
    $executeRawUnsafe: vi.fn(async () => 0),
  };
  return client;
};

beforeEach(() => {
  computeDayAggregates.mockReset();
  computeDayAggregates.mockResolvedValue({
    summaries: [{ role: 'ALL', apiRequests: 3 }],
    facts: [{ kind: 'route', role: 'ALL', key: 'GET /api/x', count: 3 }],
  });
});

describe('percentile', () => {
  it('handles empty and single inputs', () => {
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([7], 0.95)).toBe(7);
  });

  it('interpolates like percentile_cont', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(values, 0.5)).toBe(50.5);
    expect(percentile(values, 0.95)).toBeCloseTo(95.05);
  });
});

describe('days', () => {
  it('bounds an ordinary Los Angeles day at 07:00 UTC in summer', () => {
    const { from, to } = dayBounds('2026-09-27');
    expect(from.toISOString()).toBe('2026-09-27T07:00:00.000Z');
    expect(to.toISOString()).toBe('2026-09-28T07:00:00.000Z');
  });

  it('makes the spring-forward day 23 hours long', () => {
    const { from, to } = dayBounds('2026-03-08');
    expect((to - from) / 3_600_000).toBe(23);
  });

  it('refuses something that is not a day', () => {
    expect(() => dayBounds('yesterday')).toThrow();
  });

  it('shifts across month and year ends', () => {
    expect(shiftDay('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftDay('2026-03-01', -1)).toBe('2026-02-28');
  });

  it('names the day in Los Angeles, not UTC', () => {
    expect(laDay(new Date('2026-09-28T03:00:00Z'))).toBe('2026-09-27');
  });
});

describe('rollupDay', () => {
  it('replaces the day in one transaction', async () => {
    const client = fakeClient();
    await rollupDay('2026-09-26', client);
    const [ops] = client.$transaction.mock.calls[0];
    expect(ops.map((o) => o.op)).toEqual(['delS', 'delF', 'addS', 'addF']);
    const day = new Date('2026-09-26T00:00:00.000Z');
    expect(client.analyticsDailySummary.deleteMany).toHaveBeenCalledWith({ where: { day } });
    expect(client.analyticsDailyFact.createMany.mock.calls[0][0].data[0]).toMatchObject({ day, key: 'GET /api/x' });
  });

  it('is idempotent: a second run writes exactly the same rows', async () => {
    const client = fakeClient();
    await rollupDay('2026-09-26', client);
    await rollupDay('2026-09-26', client);
    const [first, second] = client.analyticsDailyFact.createMany.mock.calls;
    expect(second).toEqual(first);
    expect(client.analyticsDailyFact.deleteMany).toHaveBeenCalledTimes(2);
  });
});

describe('pruneRaw', () => {
  it('deletes in chunks until a chunk comes back short', async () => {
    const client = fakeClient();
    client.$executeRawUnsafe
      .mockResolvedValueOnce(5000)
      .mockResolvedValueOnce(1200)
      .mockResolvedValue(0);
    const pruned = await pruneRaw(new Date('2026-09-27T12:00:00Z'), client);
    expect(pruned.analytics_request_samples).toBe(6200);
    // two rounds for the first table, one for each of the other three
    expect(client.$executeRawUnsafe).toHaveBeenCalledTimes(5);
    const [sql, cutoff] = client.$executeRawUnsafe.mock.calls[0];
    expect(sql).toContain('DELETE FROM "analytics_request_samples"');
    expect(sql).toContain('$1::timestamp');
    expect(cutoff).toBe('2026-09-13T12:00:00.000Z');
  });
});

describe('daysToRollUp', () => {
  it('is yesterday and the day before on a normal night', () => {
    expect(daysToRollUp('2026-09-27', '2026-09-26')).toEqual(['2026-09-26', '2026-09-25']);
    expect(daysToRollUp('2026-09-27', null)).toEqual(['2026-09-26', '2026-09-25']);
  });

  it('catches up every day missed while the job was not running', () => {
    expect(daysToRollUp('2026-09-27', '2026-09-21')).toEqual([
      '2026-09-26',
      '2026-09-25',
      '2026-09-24',
      '2026-09-23',
      '2026-09-22',
    ]);
  });

  it('stops where the raw rows run out', () => {
    const days = daysToRollUp('2026-09-27', '2026-06-01');
    expect(days).toHaveLength(14);
    expect(days.at(-1)).toBe('2026-09-13');
  });
});

describe('runRollup', () => {
  it('catches up from the last day already rolled up', async () => {
    const client = fakeClient();
    client.analyticsDailySummary.findFirst.mockResolvedValue({ day: new Date('2026-09-22T00:00:00Z') });
    const result = await runRollup({ now: new Date('2026-09-27T18:00:00Z'), client });
    expect(result.days).toEqual(['2026-09-26', '2026-09-25', '2026-09-24', '2026-09-23']);
  });

  it('rolls up yesterday and the day before, then prunes', async () => {
    const client = fakeClient();
    const result = await runRollup({ now: new Date('2026-09-27T18:00:00Z'), client });
    expect(result.days).toEqual(['2026-09-26', '2026-09-25']);
    expect(result.summaries).toBe(2);
    expect(Object.keys(result.pruned)).toHaveLength(4);
  });

  it('refuses to overlap a run already in progress', async () => {
    const client = fakeClient();
    let release;
    computeDayAggregates.mockImplementationOnce(() => new Promise((r) => (release = r)));
    const first = runRollup({ client });
    await expect(runRollup({ client })).resolves.toBeNull();
    release({ summaries: [], facts: [] });
    await first;
  });
});
