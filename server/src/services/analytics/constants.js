// Tunables for site analytics, in one place so retention and batching can be
// read without hunting through the writers.

/** How long raw rows are kept before the nightly job deletes them. Rollups are kept. */
export const RETENTION_DAYS = Object.freeze({
  requestSamples: 14,
  clientEvents: 30,
  serverErrors: 30,
  securityEvents: 180,
});

/** Buffers write in batches: every FLUSH_INTERVAL_MS, or as soon as FLUSH_AT rows wait. */
export const FLUSH_INTERVAL_MS = 10_000;
export const FLUSH_AT = 200;
/** A buffer never holds more than this. When the database is down the oldest rows go first. */
export const BUFFER_CAP = 5_000;

/** Days are Los Angeles days, the same zone the rest of the app displays in. */
export const ANALYTICS_TZ = 'America/Los_Angeles';

/** Nightly rollup and prune, 02:15 Los Angeles time. */
export const ROLLUP_CRON = '15 2 * * *';

/** Kill switch. Read per call so a test can flip it. */
export const analyticsDisabled = () => process.env.ANALYTICS_DISABLED === '1';

export const CLIENT_EVENT_TYPES = Object.freeze([
  'page_view',
  'page_dwell',
  'click',
  'api_error',
  'api_slow',
  'js_error',
  'vital',
]);

/** Ingestion limits for POST /api/analytics/events. */
export const INGEST = Object.freeze({
  maxEvents: 50,
  maxBodyBytes: 64 * 1024,
  batchesPerMinutePerIp: 60,
  maxPath: 200,
  maxName: 120,
  maxMetaBytes: 1024,
  maxSessionId: 64,
  pastSkewMs: 10 * 60 * 1000,
  futureSkewMs: 60 * 1000,
});

export const SECURITY_KINDS = Object.freeze([
  'AUTH_DENIED',
  'ROLE_DENIED',
  'RECORD_LOCKED',
  'RATE_LIMITED',
  'LOGIN_FAILED',
  'LOGIN_OK',
  'GUARD_BYPASS_SUSPECT',
  'PATH_PROBE',
  'BRUTE_FORCE',
  'CORS_DENIED',
]);

export const SEVERITIES = Object.freeze(['INFO', 'WARN', 'CRITICAL']);

/** Brute force: this many failed logins for one address or one IP inside the window. */
export const BRUTE_FORCE = Object.freeze({ threshold: 5, windowMs: 15 * 60 * 1000 });

/** An API call slower than this is flagged by the browser as api_slow. Mirrored in the client. */
export const SLOW_API_MS = 2000;
