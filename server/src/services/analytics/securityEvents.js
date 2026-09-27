import { BRUTE_FORCE } from './constants.js';
import { roleOf } from './roles.js';
import { securityEvents } from './sinks.js';

// Denied and suspicious access, written to security_events for the Security
// tab. Every entry point is fire-and-forget: nothing here may fail or slow the
// request that triggered it.

// Paths nobody using this app ever requests, and every vulnerability scanner does.
export const PATH_PROBE_PATTERN =
  /\.(php\d?|asp|aspx|jsp|cgi|env|git|svn|sql|bak|old|swp|ini|config|yml|yaml)(\/|$)|\/wp-(admin|login|content|includes)|phpmyadmin|cgi-bin|\.\.\/|%2e%2e/i;

export function isPathProbe(path) {
  return typeof path === 'string' && PATH_PROBE_PATTERN.test(path);
}

export function recordSecurityEvent({
  kind,
  severity = 'INFO',
  user = null,
  role = null,
  ip = null,
  path = null,
  method = null,
  status = null,
  detail = null,
  at = new Date(),
}) {
  try {
    securityEvents.push({
      at,
      kind,
      severity,
      userId: user?.id ?? null,
      role: role || roleOf(user),
      ip: ip || null,
      path: path ? String(path).slice(0, 200) : null,
      method: method || null,
      status: Number.isInteger(status) ? status : null,
      detail: detail ?? undefined,
    });
  } catch {
    // Best-effort by design.
  }
}

// Sliding windows of failed logins, per IP and per address. In memory: a
// restart forgets them, which only delays the next alarm by one window.
const failures = new Map();
// Keys already alarmed in their current window, so one attack is one alarm.
const alarmed = new Map();

function noteFailure(key, now) {
  const since = now - BRUTE_FORCE.windowMs;
  const list = (failures.get(key) || []).filter((t) => t > since);
  list.push(now);
  failures.set(key, list);
  if (list.length < BRUTE_FORCE.threshold) return null;
  const last = alarmed.get(key);
  if (last && last > since) return null;
  alarmed.set(key, now);
  return list.length;
}

function sweep(now) {
  const since = now - BRUTE_FORCE.windowMs;
  for (const [key, list] of failures) {
    if (!list.some((t) => t > since)) failures.delete(key);
  }
  for (const [key, t] of alarmed) {
    if (t <= since) alarmed.delete(key);
  }
}

let lastSweep = 0;

/**
 * One failed sign-in. The address is kept lowercased in `detail`: it already
 * sits in `users` when it belongs to anybody, and an admin looking at a burst
 * of failures needs to know whose account is being tried.
 */
export function recordLoginFailed({ email, ip, reason, method = 'POST', path = '/api/auth/login', now = Date.now() }) {
  try {
    const address = typeof email === 'string' ? email.trim().toLowerCase().slice(0, 200) : null;
    recordSecurityEvent({
      kind: 'LOGIN_FAILED',
      severity: 'INFO',
      role: 'ANON',
      ip,
      path,
      method,
      status: 401,
      detail: { email: address, reason },
      at: new Date(now),
    });

    if (now - lastSweep > 60_000) {
      lastSweep = now;
      sweep(now);
    }

    const keys = [];
    if (ip) keys.push(['ip', ip]);
    if (address) keys.push(['email', address]);
    for (const [by, value] of keys) {
      const count = noteFailure(`${by}:${value}`, now);
      if (count) {
        recordSecurityEvent({
          kind: 'BRUTE_FORCE',
          severity: 'CRITICAL',
          role: 'ANON',
          ip,
          path,
          method,
          status: 401,
          detail: { by, value, failures: count, windowMinutes: BRUTE_FORCE.windowMs / 60_000 },
          at: new Date(now),
        });
      }
    }
  } catch {
    // Best-effort by design.
  }
}

export function recordLoginOk({ user, ip, path = '/api/auth/login', method = 'POST' }) {
  recordSecurityEvent({ kind: 'LOGIN_OK', severity: 'INFO', user, ip, path, method, status: 200 });
}

/** Tests only. */
export function resetLoginWindows() {
  failures.clear();
  alarmed.clear();
  lastSweep = 0;
}
