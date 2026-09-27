import { BUFFER_CAP, FLUSH_AT, FLUSH_INTERVAL_MS, analyticsDisabled } from './constants.js';
import { logError } from './log.js';

// Analytics rows are collected in memory and written in batches, so a request
// costs an array push rather than a database round trip.
//
// A buffer never throws and never blocks its caller. If the database is down
// the batch is dropped (not re-queued, which would grow without bound), and if
// rows arrive faster than they can be written the oldest are dropped at
// BUFFER_CAP. Either way the loss is counted and reported through onDropped, so
// a gap in the charts has an explanation somewhere.

const registry = new Set();

// A missing table (migration not applied yet) fails every flush. One log line
// per buffer per five minutes is enough to notice it.
const FAILURE_LOG_INTERVAL_MS = 5 * 60 * 1000;

export function createBuffer({
  name,
  write,
  flushAt = FLUSH_AT,
  cap = BUFFER_CAP,
  intervalMs = FLUSH_INTERVAL_MS,
  onDropped = null,
}) {
  let rows = [];
  let dropped = 0;
  let inFlight = null;
  let timer = null;
  let lastFailureLogAt = 0;

  const reportDropped = () => {
    if (!dropped) return;
    const count = dropped;
    dropped = 0;
    try {
      if (onDropped) onDropped(count, name);
      else logError(`[analytics] ${name}: dropped ${count} row(s)`);
    } catch {
      // Reporting a loss must not cause another.
    }
  };

  const flush = () => {
    if (inFlight) return inFlight;
    if (rows.length === 0) return Promise.resolve(0);
    const batch = rows;
    rows = [];
    inFlight = Promise.resolve()
      .then(() => write(batch))
      .then(() => {
        reportDropped();
        return batch.length;
      })
      .catch((error) => {
        dropped += batch.length;
        const now = Date.now();
        if (now - lastFailureLogAt > FAILURE_LOG_INTERVAL_MS) {
          lastFailureLogAt = now;
          logError(`[analytics] ${name}: write failed, ${batch.length} row(s) dropped:`, error?.message || error);
        }
        return 0;
      })
      .finally(() => {
        inFlight = null;
      });
    return inFlight;
  };

  const ensureTimer = () => {
    if (timer || intervalMs <= 0) return;
    timer = setInterval(() => {
      flush();
    }, intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  };

  const buffer = {
    name,
    push(row) {
      try {
        if (analyticsDisabled() || !row) return;
        if (rows.length >= cap) {
          rows.shift();
          dropped += 1;
        }
        rows.push(row);
        ensureTimer();
        if (rows.length >= flushAt) flush();
      } catch {
        // Never let bookkeeping break the caller.
      }
    },
    flush,
    /** True while `row` is still waiting to be written, so a caller may still change it. */
    has(row) {
      return rows.includes(row);
    },
    size() {
      return rows.length;
    },
    /** Tests only. */
    reset() {
      rows = [];
      dropped = 0;
      inFlight = null;
      if (timer) clearInterval(timer);
      timer = null;
    },
  };

  registry.add(buffer);
  return buffer;
}

/** Flush every buffer; resolves when all have finished. Never rejects. */
export function flushAll() {
  return Promise.allSettled([...registry].map((b) => b.flush())).then(() => undefined);
}

/** Resolves after `ms` - for racing a flush against a deadline during shutdown. */
export const sleep = (ms) =>
  new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    if (typeof t.unref === 'function') t.unref();
  });
