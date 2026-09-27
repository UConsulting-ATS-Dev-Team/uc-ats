import { CLIENT_EVENT_TYPES, INGEST } from './constants.js';
import { redactText } from './redact.js';
import { roleOf } from './roles.js';
import { normalizeRoute } from './routeNormalizer.js';

// Validation for what browsers post to /api/analytics/events. The endpoint is
// public (an anonymous visitor's page views count too), so every field is
// treated as hostile: bounded, re-normalized, and never trusted for identity.
// Who sent the batch comes from the bearer token alone.

const TYPES = new Set(CLIENT_EVENT_TYPES);
const SESSION_ID = /^[A-Za-z0-9_-]{8,64}$/;

function readMeta(meta) {
  if (meta === undefined || meta === null) return { ok: true, value: undefined };
  if (typeof meta !== 'object' || Array.isArray(meta)) return { ok: false };
  let json;
  try {
    json = JSON.stringify(meta);
  } catch {
    return { ok: false };
  }
  if (Buffer.byteLength(json, 'utf8') > INGEST.maxMetaBytes) return { ok: false };
  // Round-trip so only plain JSON is stored, then redact every string, at any depth.
  return { ok: true, value: redactDeep(JSON.parse(json)) };
}

function redactDeep(value) {
  if (typeof value === 'string') return redactText(value, 200);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactDeep(v)]));
  }
  return value;
}

function clampTime(ts, now) {
  const at = Number(ts);
  if (!Number.isFinite(at)) return new Date(now);
  return new Date(Math.min(Math.max(at, now - INGEST.pastSkewMs), now + INGEST.futureSkewMs));
}

/**
 * Parse a body into rows for analytics_client_events.
 * Returns { rows, rejected } or { error } when the body as a whole is unusable.
 */
export function readClientEvents(body, { user = null, now = Date.now() } = {}) {
  let payload = body;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      return { error: 'Body is not JSON' };
    }
  }
  const sessionId = payload?.sessionId;
  const events = payload?.events;
  if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) return { error: 'Missing or invalid sessionId' };
  if (!Array.isArray(events)) return { error: 'events must be an array' };
  if (events.length > INGEST.maxEvents) return { error: `At most ${INGEST.maxEvents} events per batch` };

  const role = roleOf(user);
  const userId = user?.id ?? null;
  const rows = [];
  let rejected = 0;

  for (const event of events) {
    if (!event || typeof event !== 'object' || !TYPES.has(event.type)) {
      rejected += 1;
      continue;
    }
    if (typeof event.path !== 'string' || event.path.length === 0 || event.path.length > INGEST.maxPath) {
      rejected += 1;
      continue;
    }
    if (event.name !== undefined && event.name !== null && (typeof event.name !== 'string' || event.name.length > INGEST.maxName)) {
      rejected += 1;
      continue;
    }
    if (event.value !== undefined && event.value !== null && !(typeof event.value === 'number' && Number.isFinite(event.value))) {
      rejected += 1;
      continue;
    }
    const meta = readMeta(event.meta);
    if (!meta.ok) {
      rejected += 1;
      continue;
    }

    rows.push({
      at: clampTime(event.ts, now),
      type: event.type,
      role,
      userId,
      sessionId,
      path: normalizeRoute(event.path, INGEST.maxPath),
      name: event.name ? redactText(event.name, INGEST.maxName) : null,
      value: typeof event.value === 'number' ? event.value : null,
      meta: meta.value,
    });
  }

  return { rows, rejected };
}

// Per-IP batch counter over a fixed one-minute window.
const windows = new Map();
let lastSweep = 0;

export function allowBatch(ip, now = Date.now()) {
  const minute = Math.floor(now / 60_000);
  if (now - lastSweep > 60_000) {
    lastSweep = now;
    for (const [k, w] of windows) if (w.minute !== minute) windows.delete(k);
  }
  const key = ip || 'unknown';
  const w = windows.get(key);
  if (!w || w.minute !== minute) {
    windows.set(key, { minute, count: 1 });
    return true;
  }
  w.count += 1;
  return w.count <= INGEST.batchesPerMinutePerIp;
}

/** Tests only. */
export function resetIngestLimits() {
  windows.clear();
  lastSweep = 0;
}
