// Turns a concrete path into the route it belongs to, so a thousand requests
// for a thousand applications count as one row, and so no id, token or address
// ends up stored in an analytics table.
//
// Deliberately regex-based rather than read from req.route: by the time
// res.on('finish') fires, Express has unwound req.baseUrl for nested routers,
// so the matched pattern is no longer reliable. The client runs the same rules
// (client/src/analytics/normalizePath.js); keep the two in step.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;
// Long opaque segments: reset tokens, Luma ids, base64url signatures, cuid-style ids.
const TOKEN = /^[A-Za-z0-9_.~-]{24,}$/;

export const MAX_ROUTE_LENGTH = 120;

function normalizeSegment(segment) {
  if (!segment) return segment;
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A malformed escape is still a segment; compare it as sent.
  }
  if (UUID.test(decoded)) return ':id';
  if (NUMERIC.test(decoded)) return ':id';
  if (decoded.includes('@')) return ':email';
  if (TOKEN.test(decoded)) return ':token';
  return segment;
}

export function normalizeRoute(rawPath, maxLength = MAX_ROUTE_LENGTH) {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return '/';
  const withoutQuery = rawPath.split(/[?#]/)[0];
  const collapsed = withoutQuery.replace(/\/{2,}/g, '/');
  const normalized = collapsed.split('/').map(normalizeSegment).join('/');
  const trimmed = normalized.length > 1 && normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  return (trimmed || '/').slice(0, maxLength);
}
