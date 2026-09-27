// The browser half of server/src/services/analytics/routeNormalizer.js; keep
// the rules the same. The server normalizes again on arrival, so this is about
// not sending ids and tokens in the first place, not about trusting the result.
//
// Only ever given a pathname. Reset and verification tokens live in the query
// string, which is never read.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC = /^\d+$/;
const TOKEN = /^[A-Za-z0-9_.~-]{24,}$/;

export const MAX_PATH_LENGTH = 200;

function segment(part) {
  if (!part) return part;
  let decoded = part;
  try {
    decoded = decodeURIComponent(part);
  } catch {
    // compare as sent
  }
  if (UUID.test(decoded) || NUMERIC.test(decoded)) return ':id';
  if (decoded.includes('@')) return ':email';
  if (TOKEN.test(decoded)) return ':token';
  return part;
}

export function normalizePath(path) {
  if (typeof path !== 'string' || !path) return '/';
  const clean = path.split(/[?#]/)[0].replace(/\/{2,}/g, '/');
  const out = clean.split('/').map(segment).join('/');
  const trimmed = out.length > 1 && out.endsWith('/') ? out.slice(0, -1) : out;
  return (trimmed || '/').slice(0, MAX_PATH_LENGTH);
}

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Mask addresses and cap length; for button labels and error messages. */
export function maskText(text, max) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim().replace(EMAIL, '[email]');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
