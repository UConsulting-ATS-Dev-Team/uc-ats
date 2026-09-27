// computeDayAggregates is SQL plus assembly. The SQL runs against Postgres in
// the verification pass; this pins the assembly: which query feeds which
// column, the ALL row, top-N trimming and the CLS scaling.
import { describe, it, expect, vi } from 'vitest';

import { computeDayAggregates, VITAL_SCALE } from './aggregate.js';

vi.mock('../../prismaClient.js', () => ({ default: {} }));

// The twelve queries, in the order computeDayAggregates issues them.
const QUERY_ORDER = [
  'requests',
  'users',
  'clients',
  'errors',
  'security',
  'routes',
  'pages',
  'dwell',
  'clicks',
  'vitals',
  'fingerprints',
  'securityKinds',
];

function clientReturning(results) {
  let i = 0;
  return { $queryRaw: vi.fn(async () => results[QUERY_ORDER[i++]] ?? []) };
}

const range = { from: new Date('2026-09-26T07:00:00Z'), to: new Date('2026-09-27T07:00:00Z') };

describe('computeDayAggregates', () => {
  it('assembles per-role and ALL summaries', async () => {
    const client = clientReturning({
      requests: [
        { role: 'MEMBER', requests: 10, e4: 1, e5: 2, p50: 40.4, p95: 310.6 },
        { role: null, requests: 12, e4: 1, e5: 2, p50: 42, p95: 300 },
      ],
      users: [
        { role: 'MEMBER', users: 3 },
        { role: null, users: 3 },
      ],
      clients: [{ role: null, sessions: 5, views: 20, clicks: 9, jsErrors: 1 }],
      errors: [{ total: 4 }],
      security: [{ role: 'ANON', warn: 2, critical: 1 }],
    });
    const { summaries } = await computeDayAggregates(range, client);
    const by = Object.fromEntries(summaries.map((s) => [s.role, s]));
    expect(by.MEMBER).toMatchObject({ apiRequests: 10, apiErrors5xx: 2, p50Ms: 40, p95Ms: 311, activeUsers: 3 });
    expect(by.ALL).toMatchObject({ apiRequests: 12, sessions: 5, pageViews: 20, clicks: 9, jsErrors: 1, serverErrors: 4 });
    expect(by.ANON).toMatchObject({ securityWarn: 2, securityCritical: 1 });
  });

  it('always returns an ALL summary, even for an empty day', async () => {
    const { summaries, facts } = await computeDayAggregates(range, clientReturning({}));
    expect(summaries).toEqual([expect.objectContaining({ role: 'ALL', apiRequests: 0, p95Ms: null })]);
    expect(facts).toEqual([]);
  });

  it('merges page views with dwell time for the same page', async () => {
    const client = clientReturning({
      pages: [{ key: '/dashboard', role: 'MEMBER', count: 7 }],
      dwell: [
        { key: '/dashboard', role: 'MEMBER', p50: 12000, p95: 60000 },
        { key: '/never-viewed', role: null, p50: 500, p95: 900 },
      ],
    });
    const { facts } = await computeDayAggregates(range, client);
    const pages = facts.filter((f) => f.kind === 'page');
    expect(pages).toContainEqual(expect.objectContaining({ key: '/dashboard', role: 'MEMBER', count: 7, p50Ms: 12000 }));
    expect(pages).toContainEqual(expect.objectContaining({ key: '/never-viewed', role: 'ALL', count: 0, p50Ms: 500 }));
  });

  it('stores CLS in thousandths', async () => {
    expect(VITAL_SCALE.CLS).toBe(1000);
    const client = clientReturning({ vitals: [{ key: 'CLS', role: null, count: 4, p50: 0.051, p95: 0.2 }] });
    const { facts } = await computeDayAggregates(range, client);
    expect(facts[0]).toMatchObject({ kind: 'vital', key: 'CLS', p50Ms: 51, p95Ms: 200 });
  });

  it('folds groups whose keys collide after truncation, so the unique index cannot abort the day', async () => {
    const longPath = `/${'a'.repeat(199)}`;
    const clicks = [
      { key: `${longPath} › Save`, role: null, count: 3 },
      { key: `${longPath} › Delete`, role: null, count: 2 },
    ];
    const { facts } = await computeDayAggregates(range, clientReturning({ clicks }));
    const kept = facts.filter((f) => f.kind === 'click');
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ count: 5 });
    expect(kept[0].key).toHaveLength(200);
  });

  it('keeps only the 500 busiest buttons', async () => {
    const clicks = Array.from({ length: 600 }, (_, i) => ({ key: `/p › b${i}`, role: null, count: i }));
    const { facts } = await computeDayAggregates(range, clientReturning({ clicks }));
    const kept = facts.filter((f) => f.kind === 'click');
    expect(kept).toHaveLength(500);
    expect(Math.min(...kept.map((f) => f.count))).toBe(100);
  });
});
