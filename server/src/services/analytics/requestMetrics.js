import { analyticsDisabled } from './constants.js';
import { evaluateGuardBypass, isStaffOnlyPath } from './guardBypass.js';
import { roleOf } from './roles.js';
import { normalizeRoute } from './routeNormalizer.js';
import { isPathProbe, recordSecurityEvent } from './securityEvents.js';
import { requestSamples } from './sinks.js';

// Times every API request and turns the status it ended with into analytics.
//
// Mounted in index.js directly after externalContainment, which has already
// resolved req.user from the bearer token for any /api request, so the role is
// known without another lookup. Mounted at the top level (not under /api) so a
// scanner probing /wp-login.php is seen too.
//
// All the work happens in res.on('finish'), after the response has gone, and
// is wrapped so that nothing here can fail a request.

// Excluded from timing: the ingestion endpoint would measure itself, and
// Render's health check would pull every percentile towards zero.
const UNSAMPLED = [/^\/api\/analytics\//, /^\/api\/health$/];

const NON_STAFF = new Set(['CANDIDATE', 'TALENT', 'CLIENT', 'ANON']);

export function classifyResponse({ method, path, status, role, hasToken }) {
  const events = [];

  if (status === 401 && hasToken && !path.startsWith('/api/auth/')) {
    // A token that no longer works: expired, revoked, or forged. Failed
    // sign-ins are recorded by the login route itself, with the address.
    events.push({ kind: 'AUTH_DENIED', severity: 'INFO' });
  } else if (status === 403) {
    const outOfPlace = role === 'CLIENT' || (NON_STAFF.has(role) && isStaffOnlyPath(path));
    events.push({ kind: 'ROLE_DENIED', severity: outOfPlace ? 'WARN' : 'INFO' });
  } else if (status === 423) {
    events.push({ kind: 'RECORD_LOCKED', severity: 'INFO' });
  } else if (status === 429) {
    events.push({ kind: 'RATE_LIMITED', severity: 'WARN' });
  }

  const bypass = evaluateGuardBypass({ method, path, status, role });
  if (bypass) events.push({ kind: 'GUARD_BYPASS_SUSPECT', severity: bypass.severity, detail: bypass.detail });

  if (isPathProbe(path)) events.push({ kind: 'PATH_PROBE', severity: 'WARN' });

  return events;
}

export function requestMetrics(req, res, next) {
  if (analyticsDisabled()) return next();

  const start = process.hrtime.bigint();

  res.on('finish', () => {
    try {
      const path = (req.originalUrl || req.url || '').split('?')[0];
      const status = res.statusCode;
      const user = req.user || null;
      const role = roleOf(user);
      const route = normalizeRoute(path);

      if (path.startsWith('/api/') && !UNSAMPLED.some((re) => re.test(path))) {
        requestSamples.push({
          at: new Date(),
          method: req.method,
          route,
          status,
          durationMs: Number((process.hrtime.bigint() - start) / 1_000_000n),
          role,
          userId: user?.id ?? null,
          ip: req.ip || null,
        });
      }

      const events = classifyResponse({
        method: req.method,
        path,
        status,
        role,
        hasToken: Boolean(req.headers?.authorization),
      });
      for (const event of events) {
        recordSecurityEvent({
          ...event,
          user,
          role,
          ip: req.ip,
          path: route,
          method: req.method,
          status,
        });
      }
    } catch {
      // Analytics never fails a request that has already been answered.
    }
  });

  next();
}

export default requestMetrics;
