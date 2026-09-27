import prisma from '../../prismaClient.js';
import { computeDayAggregates, ts, VITAL_SCALE } from './aggregate.js';
import { RETENTION_DAYS } from './constants.js';
import { dayBounds, dayValue, laDay, shiftDay } from './rollup.js';
import { ROLES } from './roles.js';

// What the admin analytics page reads. Finished days come from the rollup
// tables; today comes from the raw tables, computed on request (and memoised
// briefly, since every tab asks for it).

export const RANGE_OPTIONS = [7, 30, 90];

export const clampDays = (value) => {
  const days = Number(value);
  return RANGE_OPTIONS.includes(days) ? days : 30;
};

export const clampRole = (value) => (ROLES.includes(value) ? value : 'ALL');

const dayString = (date) => date.toISOString().slice(0, 10);
const DAY_MS = 24 * 60 * 60 * 1000;
const ratio = (part, whole) => (whole > 0 ? part / whole : null);

const LIVE_TTL_MS = 30_000;
let liveCache = null;

/** Today's aggregates so far, from the raw tables. */
export async function liveToday({ now = new Date(), client = prisma } = {}) {
  const today = laDay(now);
  if (liveCache && liveCache.day === today && now.getTime() - liveCache.at < LIVE_TTL_MS) return liveCache.value;
  const value = await computeDayAggregates({ from: dayBounds(today).from, to: now }, client);
  liveCache = { day: today, at: now.getTime(), value };
  return value;
}

/** Tests only. */
export const resetLiveCache = () => {
  liveCache = null;
};

function dayList(startDay, endDay) {
  const days = [];
  for (let d = startDay; d <= endDay; d = shiftDay(d, 1)) days.push(d);
  return days;
}

async function rangeContext(days, { now = new Date(), client = prisma } = {}) {
  const today = laDay(now);
  const startDay = shiftDay(today, -(days - 1));
  const [summaries, live, latest] = await Promise.all([
    client.analyticsDailySummary.findMany({
      where: { day: { gte: dayValue(startDay), lt: dayValue(today) } },
    }),
    liveToday({ now, client }),
    client.analyticsDailySummary.findFirst({ orderBy: { day: 'desc' }, select: { day: true } }),
  ]);

  // day -> role -> summary
  const byDay = new Map();
  for (const row of summaries) {
    const day = dayString(row.day);
    if (!byDay.has(day)) byDay.set(day, new Map());
    byDay.get(day).set(row.role, row);
  }
  byDay.set(today, new Map(live.summaries.map((s) => [s.role, s])));

  return { today, startDay, days: dayList(startDay, today), byDay, live, dataThrough: latest ? dayString(latest.day) : null };
}

function metrics(summary) {
  if (!summary) return null;
  return {
    activeUsers: summary.activeUsers,
    sessions: summary.sessions,
    pageViews: summary.pageViews,
    clicks: summary.clicks,
    apiRequests: summary.apiRequests,
    apiP50Ms: summary.p50Ms,
    apiP95Ms: summary.p95Ms,
    errors5xx: summary.apiErrors5xx,
    errorRate: ratio(summary.apiErrors5xx, summary.apiRequests),
    jsErrors: summary.jsErrors,
    serverErrors: summary.serverErrors,
    securityFlags: summary.securityWarn + summary.securityCritical,
  };
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export async function overview(days, options = {}) {
  const client = options.client || prisma;
  const ctx = await rangeContext(days, options);
  const yesterday = shiftDay(ctx.today, -1);
  const previous = shiftDay(ctx.today, -2);

  const tiles = {};
  for (const role of ['ALL', ...ROLES]) {
    tiles[role] = {
      today: metrics(ctx.byDay.get(ctx.today)?.get(role)),
      yesterday: metrics(ctx.byDay.get(yesterday)?.get(role)),
      previous: metrics(ctx.byDay.get(previous)?.get(role)),
    };
  }

  const series = ctx.days.map((day) => {
    const roles = ctx.byDay.get(day) || new Map();
    const all = roles.get('ALL');
    const activeUsers = {};
    for (const role of ROLES) activeUsers[role] = roles.get(role)?.activeUsers ?? 0;
    return {
      day,
      partial: day === ctx.today,
      activeUsers,
      sessions: all?.sessions ?? 0,
      pageViews: all?.pageViews ?? 0,
      apiRequests: all?.apiRequests ?? 0,
      errors5xx: all?.apiErrors5xx ?? 0,
      serverErrors: all?.serverErrors ?? 0,
      jsErrors: all?.jsErrors ?? 0,
      p95Ms: all?.p95Ms ?? null,
    };
  });

  return {
    days,
    today: ctx.today,
    dataThrough: ctx.dataThrough,
    tiles,
    series,
    attention: await attention({ today: ctx.today, now: options.now || new Date(), client }),
  };
}

/** The short list of things someone should look at today. */
export async function attention({ today, now = new Date(), client = prisma }) {
  const items = [];
  const dayAgo = new Date(now.getTime() - DAY_MS);
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const retention = new Date(now.getTime() - RETENTION_DAYS.serverErrors * DAY_MS);

  const [newErrors, failing, critical, email, jsErrors, routeFacts] = await Promise.all([
    client.$queryRaw`
      SELECT fingerprint,
             sum(count)::int AS count,
             min(at) AS "firstSeen",
             (array_agg(message ORDER BY at DESC))[1] AS message,
             (array_agg(route ORDER BY at DESC))[1] AS route
      FROM server_error_logs
      WHERE at >= ${ts(retention)}::timestamp
      GROUP BY fingerprint
      HAVING min(at) >= ${ts(dayAgo)}::timestamp
      ORDER BY count DESC
      LIMIT 5`,
    client.$queryRaw`
      SELECT method || ' ' || route AS route, count(*)::int AS count
      FROM analytics_request_samples
      WHERE at >= ${ts(dayAgo)}::timestamp AND status >= 500
      GROUP BY method, route
      ORDER BY count DESC
      LIMIT 5`,
    client.$queryRaw`
      SELECT kind, count(*)::int AS count, max(at) AS "lastSeen"
      FROM security_events
      WHERE at >= ${ts(weekAgo)}::timestamp AND severity = 'CRITICAL'
      GROUP BY kind
      ORDER BY count DESC`,
    client.$queryRaw`
      SELECT count(*)::int AS sent,
             count(*) FILTER (WHERE status = 'BOUNCED')::int AS bounced,
             count(*) FILTER (WHERE status = 'COMPLAINED')::int AS complained,
             count(*) FILTER (WHERE status = 'FAILED')::int AS failed
      FROM communication_logs
      WHERE channel = 'email' AND "sentAt" >= ${ts(weekAgo)}::timestamp`,
    client.$queryRaw`
      SELECT name, path, count(*)::int AS count
      FROM analytics_client_events
      WHERE type = 'js_error' AND at >= ${ts(dayAgo)}::timestamp
      GROUP BY name, path
      HAVING count(*) >= 5
      ORDER BY count DESC
      LIMIT 3`,
    client.analyticsDailyFact.findMany({
      where: { kind: 'route', role: 'ALL', day: { gte: dayValue(shiftDay(today, -8)), lt: dayValue(today) } },
      select: { day: true, key: true, count: true, p95Ms: true },
    }),
  ]);

  for (const row of critical) {
    items.push({
      type: 'security_critical',
      severity: 'error',
      tab: 'security',
      label: `${row.count} critical security event${row.count === 1 ? '' : 's'} in 7 days: ${row.kind}`,
      detail: null,
      at: row.lastSeen,
    });
  }
  for (const row of newErrors) {
    items.push({
      type: 'new_error',
      severity: 'error',
      tab: 'errors',
      label: `New server error (${row.count}×): ${String(row.message).slice(0, 140)}`,
      detail: row.route ? `Route ${row.route}` : 'First seen in the last 24 hours',
    });
  }
  for (const row of failing) {
    items.push({
      type: 'failing_route',
      severity: 'warning',
      tab: 'errors',
      label: `${row.route} answered 5xx ${row.count} time${row.count === 1 ? '' : 's'} in 24 hours`,
      detail: null,
    });
  }

  // A route whose p95 yesterday is at least double its usual (the median of
  // the seven days before), for routes busy enough for p95 to mean something.
  const yesterday = shiftDay(today, -1);
  const history = new Map();
  for (const row of routeFacts) {
    if (!history.has(row.key)) history.set(row.key, []);
    history.get(row.key).push({ day: dayString(row.day), count: row.count, p95Ms: row.p95Ms });
  }
  for (const [route, rows] of history) {
    const latest = rows.find((r) => r.day === yesterday);
    const before = rows.filter((r) => r.day < yesterday && r.p95Ms !== null).map((r) => r.p95Ms).sort((a, b) => a - b);
    if (!latest || latest.count < 20 || latest.p95Ms === null || before.length < 3) continue;
    const median = before[Math.floor(before.length / 2)];
    if (latest.p95Ms >= 500 && latest.p95Ms >= 2 * median) {
      items.push({
        type: 'slow_route',
        severity: 'warning',
        tab: 'performance',
        label: `${route} slowed down: p95 ${latest.p95Ms} ms yesterday vs ${median} ms usually`,
        detail: `${latest.count} requests`,
      });
    }
  }

  for (const row of jsErrors) {
    items.push({
      type: 'js_error',
      severity: 'warning',
      tab: 'errors',
      label: `Browser error on ${row.path} (${row.count}× in 24 hours): ${String(row.name).slice(0, 120)}`,
      detail: null,
    });
  }

  // SES reviews an account at 5% bounces or 0.1% complaints. Under 50 sends
  // one bounce is 2% and means nothing.
  const mail = email[0];
  if (mail && mail.sent >= 50) {
    const bounceRate = mail.bounced / mail.sent;
    const complaintRate = mail.complained / mail.sent;
    if (bounceRate >= 0.05 || complaintRate >= 0.001) {
      items.push({
        type: 'email_bounce',
        severity: 'error',
        tab: 'overview',
        label: `Email bounce rate ${(bounceRate * 100).toFixed(1)}%, complaint rate ${(complaintRate * 100).toFixed(2)}% over 7 days`,
        detail: `${mail.sent} sent, ${mail.bounced} bounced, ${mail.complained} complaints`,
      });
    }
  }
  if (mail && mail.failed > 0) {
    items.push({
      type: 'email_failed',
      severity: 'warning',
      tab: 'overview',
      label: `${mail.failed} email${mail.failed === 1 ? '' : 's'} failed to send in 7 days`,
      detail: 'See Master Communications → Logs',
    });
  }

  return items;
}

// ---------------------------------------------------------------------------
// Performance
// ---------------------------------------------------------------------------

/**
 * Sum facts across days for one role. Percentiles of different days cannot be
 * merged exactly, so the multi-day figure is the request-weighted mean of the
 * daily percentiles - close for steady traffic, and labelled as such on the page.
 */
function mergeFacts(rows) {
  const merged = new Map();
  for (const row of rows) {
    const m = merged.get(row.key) || { key: row.key, count: 0, errorCount: 0, p50Sum: 0, p95Sum: 0, weight: 0, maxMs: null };
    m.count += row.count;
    m.errorCount += row.errorCount;
    if (row.p50Ms !== null && row.p95Ms !== null) {
      const w = Math.max(row.count, 1);
      m.p50Sum += row.p50Ms * w;
      m.p95Sum += row.p95Ms * w;
      m.weight += w;
    }
    if (row.maxMs !== null && (m.maxMs === null || row.maxMs > m.maxMs)) m.maxMs = row.maxMs;
    merged.set(row.key, m);
  }
  return [...merged.values()].map(({ p50Sum, p95Sum, weight, ...m }) => ({
    ...m,
    p50Ms: weight ? Math.round(p50Sum / weight) : null,
    p95Ms: weight ? Math.round(p95Sum / weight) : null,
  }));
}

async function factsInRange(kinds, role, days, { now = new Date(), client = prisma } = {}) {
  const today = laDay(now);
  const startDay = shiftDay(today, -(days - 1));
  const [stored, live] = await Promise.all([
    client.analyticsDailyFact.findMany({
      where: { kind: { in: kinds }, role, day: { gte: dayValue(startDay), lt: dayValue(today) } },
      select: { kind: true, key: true, count: true, errorCount: true, p50Ms: true, p95Ms: true, maxMs: true },
    }),
    liveToday({ now, client }),
  ]);
  const todays = live.facts.filter((f) => kinds.includes(f.kind) && f.role === role);
  const all = [...stored, ...todays];
  const byKind = {};
  for (const kind of kinds) byKind[kind] = mergeFacts(all.filter((f) => f.kind === kind));
  return byKind;
}

export async function performance(days, role = 'ALL', options = {}) {
  const [facts, ctx] = await Promise.all([factsInRange(['route', 'page', 'vital'], role, days, options), rangeContext(days, options)]);

  const routes = facts.route
    .map((r) => ({
      route: r.key,
      count: r.count,
      errors5xx: r.errorCount,
      errorPct: ratio(r.errorCount, r.count),
      p50Ms: r.p50Ms,
      p95Ms: r.p95Ms,
      maxMs: r.maxMs,
    }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 300);

  const slowest = routes
    .filter((r) => r.count >= 5 && r.p95Ms !== null)
    .sort((a, b) => b.p95Ms - a.p95Ms)
    .slice(0, 10);

  const vitals = facts.vital.map((v) => {
    const scale = VITAL_SCALE[v.key] || 1;
    const unscale = (x) => (x === null ? null : x / scale);
    return { name: v.key, samples: v.count, p50: unscale(v.p50Ms), p95: unscale(v.p95Ms) };
  });

  const pages = facts.page
    .map((p) => ({ path: p.key, views: p.count, p50DwellMs: p.p50Ms }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 100);

  // Speed per user type: each role's API percentiles, per day and over the range.
  const byRole = ROLES.map((r) => {
    let requests = 0;
    let p50Sum = 0;
    let p95Sum = 0;
    let weight = 0;
    let errors = 0;
    for (const day of ctx.days) {
      const s = ctx.byDay.get(day)?.get(r);
      if (!s) continue;
      requests += s.apiRequests;
      errors += s.apiErrors5xx;
      if (s.p50Ms !== null && s.p95Ms !== null && s.apiRequests > 0) {
        p50Sum += s.p50Ms * s.apiRequests;
        p95Sum += s.p95Ms * s.apiRequests;
        weight += s.apiRequests;
      }
    }
    return {
      role: r,
      requests,
      errors5xx: errors,
      p50Ms: weight ? Math.round(p50Sum / weight) : null,
      p95Ms: weight ? Math.round(p95Sum / weight) : null,
    };
  });

  const p95Series = ctx.days.map((day) => {
    const entry = { day, partial: day === ctx.today };
    for (const r of ROLES) entry[r] = ctx.byDay.get(day)?.get(r)?.p95Ms ?? null;
    return entry;
  });

  return { days, role, today: ctx.today, dataThrough: ctx.dataThrough, byRole, p95Series, routes, slowest, vitals, pages };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export async function errors(days, options = {}) {
  const client = options.client || prisma;
  const now = options.now || new Date();
  const ctx = await rangeContext(days, options);
  // Raw rows only exist for their retention period, whatever the range asks for.
  const rangeStart = dayBounds(ctx.startDay).from;
  const serverFrom = new Date(Math.max(rangeStart.getTime(), now.getTime() - RETENTION_DAYS.serverErrors * DAY_MS));
  const requestFrom = new Date(Math.max(rangeStart.getTime(), now.getTime() - RETENTION_DAYS.requestSamples * DAY_MS));
  const clientFrom = new Date(Math.max(rangeStart.getTime(), now.getTime() - RETENTION_DAYS.clientEvents * DAY_MS));

  const [groups, failingRoutes, jsErrors, apiErrors, slowApi] = await Promise.all([
    client.$queryRaw`
      SELECT fingerprint,
             sum(count)::int AS count,
             min(at) AS "firstSeen",
             max(at) AS "lastSeen"
      FROM server_error_logs
      WHERE at >= ${ts(serverFrom)}::timestamp
      GROUP BY fingerprint
      ORDER BY count DESC
      LIMIT 100`,
    client.$queryRaw`
      SELECT method || ' ' || route AS route,
             count(*) FILTER (WHERE status >= 500)::int AS "count5xx",
             count(*)::int AS total,
             max(at) FILTER (WHERE status >= 500) AS "lastSeen"
      FROM analytics_request_samples
      WHERE at >= ${ts(requestFrom)}::timestamp
      GROUP BY method, route
      HAVING count(*) FILTER (WHERE status >= 500) > 0
      ORDER BY "count5xx" DESC
      LIMIT 50`,
    client.$queryRaw`
      SELECT name, path,
             count(*)::int AS count,
             count(DISTINCT "sessionId")::int AS sessions,
             array_agg(DISTINCT role) AS roles,
             max(at) AS "lastSeen"
      FROM analytics_client_events
      WHERE type = 'js_error' AND at >= ${ts(clientFrom)}::timestamp
      GROUP BY name, path
      ORDER BY count DESC
      LIMIT 100`,
    client.$queryRaw`
      SELECT name AS status, path,
             count(*)::int AS count,
             array_agg(DISTINCT role) AS roles,
             max(at) AS "lastSeen"
      FROM analytics_client_events
      WHERE type = 'api_error' AND at >= ${ts(clientFrom)}::timestamp
      GROUP BY name, path
      ORDER BY count DESC
      LIMIT 100`,
    client.$queryRaw`
      SELECT path,
             count(*)::int AS count,
             round(avg(value))::int AS "avgMs",
             max(value)::int AS "maxMs"
      FROM analytics_client_events
      WHERE type = 'api_slow' AND at >= ${ts(clientFrom)}::timestamp
      GROUP BY path
      ORDER BY count DESC
      LIMIT 50`,
  ]);

  const fingerprints = groups.map((g) => g.fingerprint);
  const samples = fingerprints.length
    ? await client.$queryRaw`
        SELECT DISTINCT ON (fingerprint) fingerprint, message, stack, route, status, source
        FROM server_error_logs
        WHERE fingerprint = ANY(${fingerprints}) AND at >= ${ts(serverFrom)}::timestamp
        ORDER BY fingerprint, at DESC`
    : [];
  const sampleBy = new Map(samples.map((s) => [s.fingerprint, s]));

  const perDay = ctx.days.map((day) => {
    const all = ctx.byDay.get(day)?.get('ALL');
    return {
      day,
      partial: day === ctx.today,
      serverErrors: all?.serverErrors ?? 0,
      errors5xx: all?.apiErrors5xx ?? 0,
      jsErrors: all?.jsErrors ?? 0,
    };
  });

  return {
    days,
    today: ctx.today,
    dataThrough: ctx.dataThrough,
    retentionDays: { server: RETENTION_DAYS.serverErrors, requests: RETENTION_DAYS.requestSamples, client: RETENTION_DAYS.clientEvents },
    perDay,
    server: groups.map((g) => {
      const s = sampleBy.get(g.fingerprint) || {};
      return {
        fingerprint: g.fingerprint,
        count: g.count,
        firstSeen: g.firstSeen,
        lastSeen: g.lastSeen,
        sample: { message: s.message ?? null, stack: s.stack ?? null, route: s.route ?? null, status: s.status ?? null, source: s.source ?? null },
      };
    }),
    failingRoutes,
    client: jsErrors,
    api: apiErrors,
    slowApi,
  };
}
