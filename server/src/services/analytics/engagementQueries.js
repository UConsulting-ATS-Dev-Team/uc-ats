import config from '../../config.js';
import prisma from '../../prismaClient.js';
import { ts } from './aggregate.js';
import { ANALYTICS_TZ, RETENTION_DAYS } from './constants.js';
import { KNOWN_PAGES } from './knownPages.js';
import { factsInRange, rangeContext } from './queries.js';
import { dayBounds } from './rollup.js';
import { ROLES } from './roles.js';
import { normalizeRoute } from './routeNormalizer.js';

// The Engagement and Email tabs.

const DAY_MS = 24 * 60 * 60 * 1000;
const ratio = (part, whole) => (whole > 0 ? part / whole : null);
const later = (a, b) => new Date(Math.max(a.getTime(), b.getTime()));

// ---------------------------------------------------------------------------
// Engagement
// ---------------------------------------------------------------------------

export async function engagement(days, role = 'ALL', options = {}) {
  const client = options.client || prisma;
  const now = options.now || new Date();
  const [ctx, facts] = await Promise.all([rangeContext(days, options), factsInRange(['page', 'click'], role, days, options)]);

  const perDay = ctx.days.map((day) => {
    const roles = ctx.byDay.get(day) || new Map();
    const pick = roles.get(role) || {};
    const entry = {
      day,
      partial: day === ctx.today,
      sessions: pick.sessions ?? 0,
      pageViews: pick.pageViews ?? 0,
      clicks: pick.clicks ?? 0,
      pagesPerSession: ratio(pick.pageViews ?? 0, pick.sessions ?? 0),
    };
    for (const r of ROLES) entry[r] = roles.get(r)?.activeUsers ?? 0;
    return entry;
  });

  // Distinct people over the last 7 and 30 days, per user type. Distinct
  // counts cannot be added up from daily rows, so this reads the raw tables.
  const weekAgo = new Date(now.getTime() - 7 * DAY_MS);
  const monthAgo = new Date(now.getTime() - Math.min(30, RETENTION_DAYS.clientEvents) * DAY_MS);
  const reach = await client.$queryRaw`
    SELECT role,
           count(DISTINCT "userId") FILTER (WHERE at >= ${ts(weekAgo)}::timestamp)::int AS week,
           count(DISTINCT "userId")::int AS month
    FROM (
      SELECT role, "userId", at FROM analytics_client_events WHERE at >= ${ts(monthAgo)}::timestamp AND "userId" IS NOT NULL
      UNION ALL
      SELECT role, "userId", at FROM analytics_request_samples WHERE at >= ${ts(monthAgo)}::timestamp AND "userId" IS NOT NULL
    ) u
    GROUP BY role`;
  const reachBy = Object.fromEntries(reach.map((r) => [r.role, { week: r.week, month: r.month }]));

  const topPages = facts.page
    .map((p) => ({ path: p.key, views: p.count, p50DwellMs: p.p50Ms }))
    .sort((a, b) => b.views - a.views)
    .slice(0, 50);

  const topButtons = facts.click
    .map((c) => {
      const at = c.key.indexOf(' › ');
      return at === -1 ? { path: c.key, name: '', count: c.count } : { path: c.key.slice(0, at), name: c.key.slice(at + 3), count: c.count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 100);

  // Pages nobody at all opened, whatever the user-type filter says.
  const seen = role === 'ALL' ? new Set(topPages.map((p) => p.path)) : new Set((await factsInRange(['page'], 'ALL', days, options)).page.map((p) => p.key));
  const unusedPages = KNOWN_PAGES.filter((p) => !seen.has(p));

  return {
    days,
    role,
    today: ctx.today,
    dataThrough: ctx.dataThrough,
    perDay,
    reach: ROLES.map((r) => ({ role: r, week: reachBy[r]?.week ?? 0, month: reachBy[r]?.month ?? 0 })),
    topPages,
    topButtons,
    unusedPages,
  };
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/** The app page a clicked email link lands on, normalized, or null for another site. */
export function landingPath(link, clientUrl = config.clientUrl) {
  try {
    const url = new URL(link);
    if (url.origin !== new URL(clientUrl).origin) return null;
    return normalizeRoute(url.pathname);
  } catch {
    return null;
  }
}

export async function email(days, options = {}) {
  const client = options.client || prisma;
  const now = options.now || new Date();
  const ctx = await rangeContext(days, options);
  const from = dayBounds(ctx.startDay).from;
  const clientFrom = later(from, new Date(now.getTime() - RETENTION_DAYS.clientEvents * DAY_MS));

  const [anyEngagement, categories, clicks, topLinks, bots, perDay, landing] = await Promise.all([
    client.emailEngagementEvent.findFirst({ select: { id: true } }),
    client.$queryRaw`
      SELECT coalesce(category, 'OTHER') AS category,
             count(*)::int AS sent,
             count(*) FILTER (WHERE status IN ('DELIVERED', 'CLICKED'))::int AS delivered,
             count(*) FILTER (WHERE status = 'BOUNCED')::int AS bounced,
             count(*) FILTER (WHERE status = 'COMPLAINED')::int AS complained,
             count(*) FILTER (WHERE status = 'FAILED')::int AS failed,
             count(*) FILTER (WHERE status = 'DELAYED')::int AS delayed,
             count(*) FILTER (WHERE status = 'SENT')::int AS unconfirmed
      FROM communication_logs
      WHERE channel = 'email' AND "sentAt" >= ${ts(from)}::timestamp
      GROUP BY 1`,
    // Unique people who opened / clicked each kind of email, bots excluded.
    client.$queryRaw`
      SELECT coalesce(category, 'OTHER') AS category,
             count(DISTINCT coalesce("communicationLogId", "sesMessageId" || recipient)) FILTER (WHERE kind = 'CLICK')::int AS clicked,
             count(DISTINCT coalesce("communicationLogId", "sesMessageId" || recipient)) FILTER (WHERE kind = 'OPEN')::int AS opened
      FROM email_engagement_events
      WHERE at >= ${ts(from)}::timestamp AND NOT "suspectedBot"
      GROUP BY 1`,
    client.$queryRaw`
      SELECT link, coalesce(category, 'OTHER') AS category,
             count(*)::int AS clicks,
             count(*) FILTER (WHERE NOT "suspectedBot")::int AS "humanClicks",
             count(*) FILTER (WHERE "suspectedBot")::int AS "botClicks",
             count(DISTINCT recipient) FILTER (WHERE NOT "suspectedBot")::int AS people,
             max(at) AS "lastClicked"
      FROM email_engagement_events
      WHERE kind = 'CLICK' AND at >= ${ts(from)}::timestamp AND link IS NOT NULL
      GROUP BY link, 2
      ORDER BY "humanClicks" DESC, clicks DESC
      LIMIT 50`,
    client.$queryRaw`
      SELECT coalesce("userAgent", '(none)') AS "userAgent", count(*)::int AS count
      FROM email_engagement_events
      WHERE "suspectedBot" AND at >= ${ts(from)}::timestamp
      GROUP BY 1
      ORDER BY count DESC
      LIMIT 10`,
    client.$queryRaw`
      SELECT to_char(("sentAt" AT TIME ZONE 'UTC') AT TIME ZONE ${ANALYTICS_TZ}, 'YYYY-MM-DD') AS day,
             count(*)::int AS sent,
             count(*) FILTER (WHERE status IN ('DELIVERED', 'CLICKED'))::int AS delivered,
             count(*) FILTER (WHERE status IN ('BOUNCED', 'COMPLAINED', 'FAILED'))::int AS problems,
             count(*) FILTER (WHERE status = 'CLICKED')::int AS clicked
      FROM communication_logs
      WHERE channel = 'email' AND "sentAt" >= ${ts(from)}::timestamp
      GROUP BY 1`,
    // For "did the link land somewhere broken": browser errors and views per page.
    client.$queryRaw`
      SELECT path,
             count(*) FILTER (WHERE type = 'page_view')::int AS views,
             count(*) FILTER (WHERE type = 'js_error')::int AS errors
      FROM analytics_client_events
      WHERE at >= ${ts(clientFrom)}::timestamp AND type IN ('page_view', 'js_error')
      GROUP BY path`,
  ]);

  const clicksBy = Object.fromEntries(clicks.map((c) => [c.category, c]));
  const landingBy = Object.fromEntries(landing.map((l) => [l.path, l]));
  const perDayBy = Object.fromEntries(perDay.map((d) => [d.day, d]));

  const totalSent = categories.reduce((s, c) => s + c.sent, 0);
  const totalUnconfirmed = categories.reduce((s, c) => s + c.unconfirmed, 0);

  return {
    days,
    today: ctx.today,
    dataThrough: ctx.dataThrough,
    trackingActive: Boolean(anyEngagement),
    // Every row still SENT means SES delivery events are not reaching the webhook.
    deliveryReporting: totalSent === 0 || totalUnconfirmed < totalSent,
    categories: categories
      .map((c) => {
        const engaged = clicksBy[c.category] || { clicked: 0, opened: 0 };
        return {
          ...c,
          clicked: engaged.clicked,
          opened: engaged.opened,
          deliveryRate: ratio(c.delivered, c.sent),
          bounceRate: ratio(c.bounced, c.sent),
          complaintRate: ratio(c.complained, c.sent),
          clickRate: ratio(engaged.clicked, c.delivered),
        };
      })
      .sort((a, b) => b.sent - a.sent),
    topLinks: topLinks.map((l) => {
      const path = landingPath(l.link);
      const page = path ? landingBy[path] : null;
      return {
        ...l,
        landingPath: path,
        landingViews: page?.views ?? null,
        landingErrors: page?.errors ?? null,
        landingErrorRate: page ? ratio(page.errors, page.views) : null,
      };
    }),
    bots: { count: bots.reduce((s, b) => s + b.count, 0), topUserAgents: bots },
    perDay: ctx.days.map((day) => ({ day, partial: day === ctx.today, ...{ sent: 0, delivered: 0, problems: 0, clicked: 0 }, ...perDayBy[day] })),
  };
}
