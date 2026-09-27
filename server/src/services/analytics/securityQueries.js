import prisma from '../../prismaClient.js';
import { ts } from './aggregate.js';
import { ANALYTICS_TZ, SECURITY_KINDS } from './constants.js';
import { runPostureChecks } from './posture.js';
import { rangeContext } from './queries.js';
import { dayBounds } from './rollup.js';
import { ROLES } from './roles.js';

// The Security tab: configuration posture, and who was refused or did
// something suspicious, from security_events and the exec-access log.

// Worth a look even one at a time. The others (an expired token, a member
// refused an admin page) are routine and only matter in bulk.
export const ANOMALY_KINDS = ['GUARD_BYPASS_SUSPECT', 'BRUTE_FORCE', 'PATH_PROBE', 'CORS_DENIED', 'RATE_LIMITED'];
export const DENIED_KINDS = ['AUTH_DENIED', 'ROLE_DENIED', 'RECORD_LOCKED', 'RATE_LIMITED', 'LOGIN_FAILED', 'CORS_DENIED', 'GUARD_BYPASS_SUSPECT', 'PATH_PROBE', 'BRUTE_FORCE'];
export const PAGE_SIZE = 50;

const dayOf = (column) => `to_char((${column} AT TIME ZONE 'UTC') AT TIME ZONE '${ANALYTICS_TZ}', 'YYYY-MM-DD')`;

/** Filters from the query string, reduced to known values. */
export function readSecurityFilters(query = {}) {
  const kind = DENIED_KINDS.includes(query.kind) ? query.kind : null;
  const role = ROLES.includes(query.role) ? query.role : null;
  const ip = typeof query.ip === 'string' && /^[0-9a-fA-F:.]{1,45}$/.test(query.ip) ? query.ip : null;
  const pageOf = (v) => Math.max(0, Math.min(1000, Number.parseInt(v, 10) || 0));
  return { kind, role, ip, page: pageOf(query.page), execPage: pageOf(query.execPage) };
}

const EXEC_ACTIONS = ['UNLOCK_OK', 'UNLOCK_FAILED', 'UNLOCK_RATE_LIMITED', 'UNLOCK_RECORD', 'PASSWORD_SET'];

async function emailsFor(userIds, client) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return {};
  const users = await client.user.findMany({ where: { id: { in: ids } }, select: { id: true, email: true, fullName: true } });
  return Object.fromEntries(users.map((u) => [u.id, u]));
}

export async function security(days, filters = {}, options = {}) {
  const client = options.client || prisma;
  const ctx = await rangeContext(days, options);
  const from = ts(dayBounds(ctx.startDay).from);
  const { kind, role, ip, page = 0, execPage = 0 } = filters;
  const execWhere = { createdAt: { gte: dayBounds(ctx.startDay).from }, action: { in: EXEC_ACTIONS } };

  const deniedWhere = {
    at: { gte: dayBounds(ctx.startDay).from },
    kind: kind ? kind : { in: DENIED_KINDS },
    ...(role ? { role } : {}),
    ...(ip ? { ip } : {}),
  };

  const [posture, anomalies, deniedRows, deniedTotal, byKind, execLog, execTotal, logins, topIps] = await Promise.all([
    runPostureChecks({ client }),
    client.$queryRaw`
      SELECT kind, ip, path, role,
             CASE WHEN bool_or(severity = 'CRITICAL') THEN 'CRITICAL'
                  WHEN bool_or(severity = 'WARN') THEN 'WARN' ELSE 'INFO' END AS severity,
             count(*)::int AS count, min(at) AS "firstSeen", max(at) AS "lastSeen",
             (array_agg(detail ORDER BY at DESC))[1] AS detail
      FROM security_events
      WHERE at >= ${from}::timestamp AND (kind = ANY(${ANOMALY_KINDS}) OR severity = 'CRITICAL')
      GROUP BY kind, ip, path, role
      ORDER BY bool_or(severity = 'CRITICAL') DESC, max(at) DESC
      LIMIT 100`,
    client.securityEvent.findMany({
      where: deniedWhere,
      orderBy: { at: 'desc' },
      skip: page * PAGE_SIZE,
      take: PAGE_SIZE,
      select: { id: true, at: true, kind: true, severity: true, userId: true, role: true, ip: true, path: true, method: true, status: true, detail: true },
    }),
    client.securityEvent.count({ where: deniedWhere }),
    client.$queryRaw`
      SELECT kind, count(*)::int AS count,
             count(*) FILTER (WHERE severity = 'WARN')::int AS warn,
             count(*) FILTER (WHERE severity = 'CRITICAL')::int AS critical
      FROM security_events
      WHERE at >= ${from}::timestamp
      GROUP BY kind`,
    // Paged, never capped: this list promises every use of the unlock.
    client.execAccessLog.findMany({
      where: execWhere,
      orderBy: { createdAt: 'desc' },
      skip: execPage * PAGE_SIZE,
      take: PAGE_SIZE,
      select: { id: true, action: true, userId: true, ipAddress: true, candidateId: true, createdAt: true },
    }),
    client.execAccessLog.count({ where: execWhere }),
    client.$queryRawUnsafe(
      `SELECT ${dayOf('at')} AS day, role,
              count(*) FILTER (WHERE kind = 'LOGIN_OK')::int AS ok,
              count(*) FILTER (WHERE kind = 'LOGIN_FAILED')::int AS failed
       FROM security_events
       WHERE at >= $1::timestamp AND kind IN ('LOGIN_OK', 'LOGIN_FAILED')
       GROUP BY 1, 2`,
      from
    ),
    client.$queryRaw`
      SELECT ip, count(*)::int AS events,
             count(*) FILTER (WHERE severity = 'WARN')::int AS warn,
             count(*) FILTER (WHERE severity = 'CRITICAL')::int AS critical,
             array_agg(DISTINCT kind) AS kinds,
             max(at) AS "lastSeen"
      FROM security_events
      WHERE at >= ${from}::timestamp AND ip IS NOT NULL AND kind <> 'LOGIN_OK'
      GROUP BY ip
      ORDER BY critical DESC, warn DESC, events DESC
      LIMIT 20`,
  ]);

  const people = await emailsFor([...deniedRows.map((r) => r.userId), ...execLog.map((r) => r.userId)], client);
  const who = (id) => (id && people[id] ? { email: people[id].email, name: people[id].fullName } : null);

  const loginsPerDay = ctx.days.map((day) => {
    const rows = logins.filter((l) => l.day === day);
    return {
      day,
      partial: day === ctx.today,
      ok: rows.reduce((s, r) => s + r.ok, 0),
      failed: rows.reduce((s, r) => s + r.failed, 0),
    };
  });

  const execRows = execLog.map((r) => ({ ...r, user: who(r.userId) }));

  return {
    days,
    today: ctx.today,
    dataThrough: ctx.dataThrough,
    filters: { kind, role, ip, page, execPage },
    kinds: SECURITY_KINDS,
    posture,
    summary: Object.fromEntries(byKind.map((k) => [k.kind, { count: k.count, warn: k.warn, critical: k.critical }])),
    anomalies,
    denied: { rows: deniedRows.map((r) => ({ ...r, user: who(r.userId) })), total: deniedTotal, page, pageSize: PAGE_SIZE },
    // Who opened sealed records, and who failed to. The executive unlock is the
    // one sanctioned way past a seal, so every use of it is on this list.
    execAccess: { rows: execRows, total: execTotal, page: execPage, pageSize: PAGE_SIZE },
    loginsPerDay,
    topIps,
  };
}
