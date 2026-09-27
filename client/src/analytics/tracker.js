import { normalizePath } from './normalizePath';

// Collects Site Analytics events in the browser and posts them in batches to
// /api/analytics/events. Nothing here may ever break the page: every entry
// point swallows its own errors, and the queue is capped.
//
// Identity is not sent. The server reads it from the bearer token, which is
// why even the page-close flush uses fetch({ keepalive }) - unlike sendBeacon
// it can carry the Authorization header. sendBeacon (anonymous) is only the
// fallback for a browser where that fetch throws.
//
// track() only queues until startTracker() runs (from initAnalytics in
// main.jsx), so the many component tests that import apiClient never send.

const ENDPOINT = '/api/analytics/events';
export const FLUSH_INTERVAL_MS = 10_000;
export const FLUSH_AT = 20;
export const QUEUE_CAP = 200;
// The server refuses larger batches.
const BATCH_MAX = 50;
const SESSION_KEY = 'uc-ats:analytics-session';

let queue = [];
let started = false;
let timer = null;
let sessionId = null;

export const analyticsDisabled = () => import.meta.env.VITE_ANALYTICS_DISABLED === '1';

function newId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID().replace(/-/g, '');
  } catch {
    // fall through
  }
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/** One id per browser tab, kept for the life of the tab. */
export function getSessionId() {
  if (sessionId) return sessionId;
  try {
    sessionId = sessionStorage.getItem(SESSION_KEY);
    if (!sessionId) {
      sessionId = newId();
      sessionStorage.setItem(SESSION_KEY, sessionId);
    }
  } catch {
    sessionId = sessionId || newId();
  }
  return sessionId;
}

function authToken() {
  try {
    return localStorage.getItem('token');
  } catch {
    return null;
  }
}

function send(events, token) {
  const body = JSON.stringify({ sessionId: getSessionId(), events });
  const headers = { 'Content-Type': 'text/plain' };
  if (token) headers.Authorization = `Bearer ${token}`;
  try {
    const request = fetch(ENDPOINT, { method: 'POST', headers, body, keepalive: true, credentials: 'same-origin' });
    // An unreachable server or a 429 costs these events, nothing more.
    Promise.resolve(request).catch(() => {});
  } catch {
    try {
      navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: 'text/plain' }));
    } catch {
      // Nowhere left to send it.
    }
  }
}

/** Send everything queued. */
export function flush() {
  try {
    if (!started || queue.length === 0) return;
    // Each event goes out under the session it happened in. A page viewed
    // signed out and a login before the next flush must not hand those views
    // to the new account, so a batch never spans a change of token.
    while (queue.length) {
      const token = queue[0].token;
      let end = 0;
      while (end < queue.length && end < BATCH_MAX && queue[end].token === token) end += 1;
      send(queue.splice(0, end).map((item) => item.event), token);
    }
  } catch {
    queue = [];
  }
}

/**
 * Queue one event. `path` defaults to the current page and is normalized
 * either way; `name` is a label, message or metric name; `value` a number.
 */
export function track(type, { path, name, value, meta } = {}) {
  try {
    if (analyticsDisabled()) return;
    const event = {
      type,
      path: normalizePath(path ?? window.location.pathname),
      ts: Date.now(),
    };
    if (name !== undefined && name !== null && name !== '') event.name = String(name).slice(0, 120);
    if (typeof value === 'number' && Number.isFinite(value)) event.value = value;
    if (meta && typeof meta === 'object') event.meta = meta;
    if (queue.length >= QUEUE_CAP) queue.shift();
    queue.push({ event, token: authToken() });
    if (started && queue.length >= FLUSH_AT) flush();
  } catch {
    // Analytics never breaks the page.
  }
}

const hiddenListeners = [];

/** Run `fn` when the page is going away or into the background. */
export function onPageHide(fn) {
  hiddenListeners.push(fn);
}

function handleHide() {
  for (const fn of hiddenListeners) {
    try {
      fn();
    } catch {
      // keep going
    }
  }
  flush();
}

export function startTracker() {
  if (started || analyticsDisabled()) return;
  started = true;
  timer = setInterval(flush, FLUSH_INTERVAL_MS);
  window.addEventListener('pagehide', handleHide);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') handleHide();
  });
}

/** Tests only. */
export function resetTracker() {
  queue = [];
  started = false;
  sessionId = null;
  hiddenListeners.length = 0;
  if (timer) clearInterval(timer);
  timer = null;
  window.removeEventListener('pagehide', handleHide);
}

/** Tests only. */
export const queuedEvents = () => queue.map((item) => item.event);
