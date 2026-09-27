import prisma from '../../prismaClient.js';

// Raw rows -> one day's summaries and facts. Used by the nightly rollup (for a
// finished day) and by the admin page (for today so far), so the two can never
// disagree about what a number means.
//
// Every query groups with ROLLUP or GROUPING SETS so the 'ALL' row comes out of
// the same pass as the per-role rows. Percentiles cannot be added up, so ALL
// has to be computed, not summed.

const KEY_MAX = 200;

/**
 * A query parameter for a `timestamp(3)` column. Prisma stores those as UTC
 * wall-clock time with no zone, but a JS Date sent to $queryRaw is compared in
 * the session's time zone - fine on Supabase (UTC), hours off anywhere else.
 * An ISO string cast with ::timestamp drops the Z and compares as UTC wall
 * time, whatever the session zone. Use as `${ts(date)}::timestamp`.
 */
export const ts = (date) => new Date(date).toISOString();
// A day can have thousands of distinct buttons or pages; the long tail is noise.
const TOP_N = 500;

const n = (v) => (v === null || v === undefined ? 0 : Number(v));
const ms = (v) => (v === null || v === undefined ? null : Math.round(Number(v)));
const key = (v) => String(v ?? '').slice(0, KEY_MAX);
const roleKey = (r) => r || 'ALL';

/**
 * Web vitals share the facts table's integer columns. CLS is a unitless score
 * around 0.1, so it is stored in thousandths; everything else is milliseconds.
 */
export const VITAL_SCALE = { CLS: 1000 };

/** Linear-interpolated percentile of an ascending array, the same method as percentile_cont. */
export function percentile(sorted, p) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (sorted.length - 1) * p;
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

function emptySummary(role) {
  return {
    role,
    activeUsers: 0,
    sessions: 0,
    pageViews: 0,
    clicks: 0,
    apiRequests: 0,
    apiErrors4xx: 0,
    apiErrors5xx: 0,
    p50Ms: null,
    p95Ms: null,
    jsErrors: 0,
    serverErrors: 0,
    securityWarn: 0,
    securityCritical: 0,
  };
}

const topByCount = (facts) => facts.sort((a, b) => b.count - a.count).slice(0, TOP_N);

/**
 * { summaries: [{ role, ...counts }], facts: [{ kind, role, key, count, errorCount, p50Ms, p95Ms, maxMs }] }
 * for rows with from <= at < to.
 */
export async function computeDayAggregates({ from, to }, client = prisma) {
  const [requests, users, clients, errors, security, routes, pages, dwell, clicks, vitals, fingerprints, securityKinds] =
    await Promise.all([
      client.$queryRaw`
        SELECT role,
               count(*)::int AS requests,
               count(*) FILTER (WHERE status BETWEEN 400 AND 499)::int AS e4,
               count(*) FILTER (WHERE status >= 500)::int AS e5,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY "durationMs") AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs") AS p95
        FROM analytics_request_samples
        WHERE at >= ${ts(from)}::timestamp AND at < ${ts(to)}::timestamp
        GROUP BY ROLLUP(role)`,
      // Someone counts as active if they made a request or the browser reported
      // anything for them. Anonymous visitors have no id and show up as sessions.
      client.$queryRaw`
        SELECT role, count(DISTINCT "userId")::int AS users
        FROM (
          SELECT role, "userId" FROM analytics_request_samples
          WHERE at >= ${ts(from)}::timestamp AND at < ${ts(to)}::timestamp AND "userId" IS NOT NULL
          UNION
          SELECT role, "userId" FROM analytics_client_events
          WHERE at >= ${ts(from)}::timestamp AND at < ${ts(to)}::timestamp AND "userId" IS NOT NULL
        ) u
        GROUP BY ROLLUP(role)`,
      client.$queryRaw`
        SELECT role,
               count(DISTINCT "sessionId")::int AS sessions,
               count(*) FILTER (WHERE type = 'page_view')::int AS views,
               count(*) FILTER (WHERE type = 'click')::int AS clicks,
               count(*) FILTER (WHERE type = 'js_error')::int AS "jsErrors"
        FROM analytics_client_events
        WHERE at >= ${ts(from)}::timestamp AND at < ${ts(to)}::timestamp
        GROUP BY ROLLUP(role)`,
      client.$queryRaw`
        SELECT coalesce(sum(count), 0)::int AS total
        FROM server_error_logs
        WHERE at >= ${ts(from)}::timestamp AND at < ${ts(to)}::timestamp`,
      client.$queryRaw`
        SELECT role,
               count(*) FILTER (WHERE severity = 'WARN')::int AS warn,
               count(*) FILTER (WHERE severity = 'CRITICAL')::int AS critical
        FROM security_events
        WHERE at >= ${ts(from)}::timestamp AND at < ${ts(to)}::timestamp
        GROUP BY ROLLUP(role)`,
      client.$queryRaw`
        SELECT method || ' ' || route AS key, role,
               count(*)::int AS count,
               count(*) FILTER (WHERE status >= 500)::int AS "errorCount",
               percentile_cont(0.5) WITHIN GROUP (ORDER BY "durationMs") AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY "durationMs") AS p95,
               max("durationMs") AS max
        FROM analytics_request_samples
        WHERE at >= ${ts(from)}::timestamp AND at < ${ts(to)}::timestamp
        GROUP BY GROUPING SETS ((method, route, role), (method, route))`,
      client.$queryRaw`
        SELECT path AS key, role, count(*)::int AS count
        FROM analytics_client_events
        WHERE at >= ${ts(from)}::timestamp AND at < ${ts(to)}::timestamp AND type = 'page_view'
        GROUP BY GROUPING SETS ((path, role), (path))`,
      client.$queryRaw`
        SELECT path AS key, role,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY value) AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY value) AS p95
        FROM analytics_client_events
        WHERE at >= ${ts(from)}::timestamp AND at < ${ts(to)}::timestamp AND type = 'page_dwell' AND value IS NOT NULL
        GROUP BY GROUPING SETS ((path, role), (path))`,
      client.$queryRaw`
        SELECT path || ' › ' || coalesce(name, '') AS key, role, count(*)::int AS count
        FROM analytics_client_events
        WHERE at >= ${ts(from)}::timestamp AND at < ${ts(to)}::timestamp AND type = 'click'
        GROUP BY GROUPING SETS ((path, name, role), (path, name))`,
      client.$queryRaw`
        SELECT name AS key, role,
               count(*)::int AS count,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY value) AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY value) AS p95
        FROM analytics_client_events
        WHERE at >= ${ts(from)}::timestamp AND at < ${ts(to)}::timestamp AND type = 'vital' AND value IS NOT NULL AND name IS NOT NULL
        GROUP BY GROUPING SETS ((name, role), (name))`,
      client.$queryRaw`
        SELECT fingerprint AS key, coalesce(sum(count), 0)::int AS count
        FROM server_error_logs
        WHERE at >= ${ts(from)}::timestamp AND at < ${ts(to)}::timestamp
        GROUP BY fingerprint`,
      client.$queryRaw`
        SELECT kind AS key, role,
               count(*)::int AS count,
               count(*) FILTER (WHERE severity = 'CRITICAL')::int AS "errorCount"
        FROM security_events
        WHERE at >= ${ts(from)}::timestamp AND at < ${ts(to)}::timestamp
        GROUP BY GROUPING SETS ((kind, role), (kind))`,
    ]);

  const summaries = new Map([['ALL', emptySummary('ALL')]]);
  const summary = (role) => {
    const r = roleKey(role);
    if (!summaries.has(r)) summaries.set(r, emptySummary(r));
    return summaries.get(r);
  };

  for (const row of requests) {
    const s = summary(row.role);
    s.apiRequests = n(row.requests);
    s.apiErrors4xx = n(row.e4);
    s.apiErrors5xx = n(row.e5);
    s.p50Ms = ms(row.p50);
    s.p95Ms = ms(row.p95);
  }
  for (const row of users) summary(row.role).activeUsers = n(row.users);
  for (const row of clients) {
    const s = summary(row.role);
    s.sessions = n(row.sessions);
    s.pageViews = n(row.views);
    s.clicks = n(row.clicks);
    s.jsErrors = n(row.jsErrors);
  }
  for (const row of security) {
    const s = summary(row.role);
    s.securityWarn = n(row.warn);
    s.securityCritical = n(row.critical);
  }
  // Server errors are not tied to whoever was signed in.
  summary('ALL').serverErrors = n(errors[0]?.total);

  const fact = (kind, row, extra = {}) => ({
    kind,
    role: roleKey(row.role),
    key: key(row.key),
    count: n(row.count),
    errorCount: n(row.errorCount),
    p50Ms: null,
    p95Ms: null,
    maxMs: null,
    ...extra,
  });

  const pageFacts = new Map();
  for (const row of pages) {
    const f = fact('page', row);
    pageFacts.set(`${f.role}|${f.key}`, f);
  }
  for (const row of dwell) {
    const id = `${roleKey(row.role)}|${key(row.key)}`;
    const f = pageFacts.get(id) || fact('page', { ...row, count: 0 });
    f.p50Ms = ms(row.p50);
    f.p95Ms = ms(row.p95);
    pageFacts.set(id, f);
  }

  const facts = [
    ...routes.map((row) => fact('route', row, { p50Ms: ms(row.p50), p95Ms: ms(row.p95), maxMs: ms(row.max) })),
    ...topByCount([...pageFacts.values()]),
    ...topByCount(clicks.map((row) => fact('click', row))),
    ...vitals.map((row) => {
      const scale = VITAL_SCALE[row.key] || 1;
      const scaled = (v) => (v === null || v === undefined ? null : Math.round(Number(v) * scale));
      return fact('vital', row, { p50Ms: scaled(row.p50), p95Ms: scaled(row.p95) });
    }),
    ...topByCount(fingerprints.map((row) => fact('error_fingerprint', { ...row, role: 'ALL' }))),
    ...securityKinds.map((row) => fact('security_kind', row)),
  ];

  return { summaries: [...summaries.values()], facts: mergeDuplicateKeys(facts) };
}

/**
 * Keys are capped at KEY_MAX, so two groups SQL kept apart (two buttons on one
 * very long path) can arrive with the same key. The unique index on
 * (day, kind, role, key) would then abort the whole day's rollup, so they are
 * folded into one fact here: counts add up, and the percentiles of the busier
 * group stand for both.
 */
export function mergeDuplicateKeys(facts) {
  const merged = new Map();
  for (const fact of facts) {
    const id = `${fact.kind}|${fact.role}|${fact.key}`;
    const seen = merged.get(id);
    if (!seen) {
      merged.set(id, { ...fact });
      continue;
    }
    const busier = fact.count > seen.count ? fact : seen;
    merged.set(id, {
      ...busier,
      count: seen.count + fact.count,
      errorCount: seen.errorCount + fact.errorCount,
      maxMs: seen.maxMs === null ? fact.maxMs : fact.maxMs === null ? seen.maxMs : Math.max(seen.maxMs, fact.maxMs),
    });
  }
  return [...merged.values()];
}
