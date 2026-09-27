import crypto from 'node:crypto';

import { flushAll, sleep } from './buffer.js';
import { logError } from './log.js';
import { redactText } from './redact.js';
import { normalizeRoute } from './routeNormalizer.js';
import { recordSecurityEvent } from './securityEvents.js';
import { serverErrors } from './sinks.js';

// Server failures, for the Errors tab. Three ways in:
//
//   1. console.error. Every route here catches its own errors and logs them
//      with console.error before answering 500 (500+ call sites), so wrapping
//      it once catches what they catch without touching any of them.
//   2. expressErrorHandler, for whatever a route throws without catching.
//   3. unhandledRejection / uncaughtException, which record and then exit
//      exactly as Node would have.
//
// installErrorCapture() is called from index.js only. Tests import services
// directly, and a wrapper installed at import time would leak into all of them.

const DEDUPE_WINDOW_MS = 60_000;
const DEDUPE_MAX = 500;
const CRASH_FLUSH_MS = 1500;

// Prisma logs a failed query through console.error on its own, outside any
// flag this module can set. A failed analytics write (the migration not run
// yet, say) must not be captured as a server error, buffered, fail to write,
// and be captured again.
const ANALYTICS_OWN_WRITES =
  /analytics_request_samples|analytics_client_events|server_error_logs|security_events|analytics_daily_|analyticsRequestSample|analyticsClientEvent|serverErrorLog|securityEvent\.|analyticsDaily|\[analytics\]/i;

// Logged with console.error but not a server failure. requireAuth logs every
// expired or forged token (middleware/auth.js); those are already counted as
// AUTH_DENIED on the security side, and on the Errors tab they would bury the
// real failures.
const NOT_A_FAILURE = /^Auth middleware error:/;

/** Stable across the ids, numbers and quoted values that differ between two occurrences of one error. */
export function fingerprint(message, route = null) {
  const normalized = String(message || '')
    .toLowerCase()
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<id>')
    .replace(/(["'`]).*?\1/g, '<str>')
    .replace(/\d+/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  return crypto.createHash('sha1').update(`${normalized}|${route || ''}`).digest('hex');
}

// fingerprint -> { row, at }, insertion-ordered so the oldest is evicted first.
const recent = new Map();

export function recordServerError({ source, message, stack = null, route = null, status = null, now = Date.now() }) {
  try {
    const text = redactText(message || 'Unknown error', 2000);
    const fp = fingerprint(text, route);
    const seen = recent.get(fp);
    if (seen && now - seen.at < DEDUPE_WINDOW_MS && serverErrors.has(seen.row)) {
      seen.row.count += 1;
      return;
    }
    const row = {
      at: new Date(now),
      source,
      message: text,
      stack: stack ? redactText(stack, 4000) : null,
      route: route || null,
      status: Number.isInteger(status) ? status : null,
      fingerprint: fp,
      count: 1,
    };
    recent.delete(fp);
    recent.set(fp, { row, at: now });
    if (recent.size > DEDUPE_MAX) recent.delete(recent.keys().next().value);
    serverErrors.push(row);
  } catch {
    // Best-effort by design.
  }
}

/** Turn console.error's arguments into { message, stack }. */
export function describeArgs(args) {
  const error = args.find((a) => a instanceof Error);
  const parts = [];
  for (const arg of args) {
    if (arg instanceof Error) parts.push(arg.message);
    else if (typeof arg === 'string') parts.push(arg);
    else if (arg && typeof arg === 'object') {
      try {
        parts.push(JSON.stringify(arg).slice(0, 300));
      } catch {
        parts.push('[object]');
      }
    } else if (arg !== undefined) parts.push(String(arg));
  }
  return { message: parts.join(' ').trim() || 'console.error with no message', stack: error?.stack || null };
}

let installed = null;
let capturing = false;

export function installErrorCapture({ exit = (code) => process.exit(code) } = {}) {
  if (installed) return;
  const original = console.error;

  const wrapper = (...args) => {
    original.apply(console, args);
    // Anything logged while capturing - including a failure inside the capture
    // itself - is printed but not captured again.
    if (capturing) return;
    capturing = true;
    try {
      const { message, stack } = describeArgs(args);
      if (ANALYTICS_OWN_WRITES.test(message) || NOT_A_FAILURE.test(message)) return;
      recordServerError({ source: 'console', message, stack });
    } catch {
      // Never let capture change what console.error does.
    } finally {
      capturing = false;
    }
  };

  // Registering either listener stops Node from crashing on its own, so each
  // one records, gives the row a moment to reach the database, and then exits
  // the way Node would have. Render restarts the service either way.
  const crash = (kind) => (reason) => {
    try {
      const err = reason instanceof Error ? reason : new Error(String(reason));
      logError(`[${kind}]`, err);
      recordServerError({ source: 'unhandled', message: `${kind}: ${err.message}`, stack: err.stack });
    } catch {
      // Fall through to the exit.
    }
    Promise.race([flushAll(), sleep(CRASH_FLUSH_MS)]).finally(() => exit(1));
  };
  const onRejection = crash('unhandledRejection');
  const onException = crash('uncaughtException');

  console.error = wrapper;
  process.on('unhandledRejection', onRejection);
  process.on('uncaughtException', onException);
  installed = { original, wrapper, onRejection, onException };
}

/** Tests only. */
export function uninstallErrorCapture() {
  if (!installed) return;
  if (console.error === installed.wrapper) console.error = installed.original;
  process.off('unhandledRejection', installed.onRejection);
  process.off('uncaughtException', installed.onException);
  installed = null;
  recent.clear();
}

/**
 * The last middleware in index.js. Express 5 sends a rejected route promise
 * here, as well as body-parser and CORS failures, all of which previously got
 * Express's default HTML page.
 */
// eslint-disable-next-line no-unused-vars
export function expressErrorHandler(err, req, res, next) {
  let status = Number(err?.status ?? err?.statusCode) || 500;
  const path = (req.originalUrl || req.url || '').split('?')[0];

  if (err?.message === 'Not allowed by CORS') {
    status = 403;
    recordSecurityEvent({
      kind: 'CORS_DENIED',
      severity: 'WARN',
      user: req.user,
      ip: req.ip,
      path: normalizeRoute(path),
      method: req.method,
      status,
      detail: { origin: req.headers?.origin || null },
    });
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
  }

  if (status >= 500) {
    recordServerError({
      source: 'request',
      message: err?.message || String(err),
      stack: err?.stack || null,
      route: normalizeRoute(path),
      status,
    });
    logError(`[${req.method} ${path}] unhandled route error:`, err);
  }

  if (res.headersSent) return next(err);
  const message = status >= 500 ? 'Internal server error' : err?.message || 'Request failed';
  return res.status(status).json({ error: message });
}
