import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/**
 * Returned by a `fetcher` that checked for new data and found none. The poll counts as
 * a success -- status stays LIVE and `lastSyncAt` advances -- but `onData` is not called
 * and nothing on screen is replaced. Lets a caller poll a cheap change token often and
 * pay for an expensive read only when that token moves.
 */
export const POLL_NO_CHANGE = Symbol('POLL_NO_CHANGE');

export const POLL_STATUS = {
  IDLE: 'idle',
  LOADING: 'loading',
  LIVE: 'live',
  PAUSED: 'paused',
  ERROR: 'error'
};

const DEFAULT_INTERVAL = 60 * 1000;
const DEFAULT_MAX_INTERVAL = 5 * 60 * 1000;
const DEFAULT_BACKOFF_FACTOR = 2;

function isDocumentVisible() {
  if (typeof document === 'undefined') return true;
  return document.visibilityState !== 'hidden';
}

/**
 * Polls a resource on a bounded interval and converges on server state.
 *
 * Guarantees:
 * - one request in flight at a time (single-flight); overlapping triggers are dropped
 * - request ownership is per-run: a superseded run can neither release the single-flight
 *   slot nor arm the interval timer on behalf of its replacement
 * - every request is cancellable and is aborted on unmount, disable, or manual refresh
 * - polling pauses while the document is hidden and resumes with an immediate fetch
 * - failures back off exponentially up to `maxInterval` and surface as visible state
 * - a response is discarded when a newer response has already been applied, either by
 *   arrival order or by `getVersion` (server `updatedAt`/version semantics)
 * - a fetcher may resolve with `POLL_NO_CHANGE` to report "nothing new" without
 *   replacing anything on screen
 *
 * @param {(signal: AbortSignal) => Promise<any>} options.fetcher resolve with
 *   `POLL_NO_CHANGE` to record a successful poll that found nothing new
 * @param {number} [options.interval] base interval in ms
 * @param {boolean} [options.enabled] pause polling entirely when false
 * @param {boolean} [options.immediate] fetch on mount instead of after one interval
 * @param {boolean} [options.pauseWhenHidden] pause while the tab/page is hidden
 * @param {number} [options.maxInterval] backoff ceiling in ms
 * @param {(payload: any) => number|string|null} [options.getVersion] monotonic server version
 * @param {number|string|null} [options.initialVersion] version of data already on screen
 *   (for example a snapshot restored from a cache) so responses older than it are dropped
 * @param {(payload: any) => void} [options.onData] called only for accepted responses
 * @param {(error: Error) => void} [options.onError]
 */
export default function usePolling({
  fetcher,
  interval = DEFAULT_INTERVAL,
  enabled = true,
  immediate = true,
  pauseWhenHidden = true,
  maxInterval = DEFAULT_MAX_INTERVAL,
  backoffFactor = DEFAULT_BACKOFF_FACTOR,
  getVersion,
  initialVersion = null,
  onData,
  onError
} = {}) {
  const [status, setStatus] = useState(POLL_STATUS.IDLE);
  const [error, setError] = useState(null);
  const [lastSyncAt, setLastSyncAt] = useState(null);
  const [metrics, setMetrics] = useState({
    requests: 0,
    failures: 0,
    discarded: 0,
    unchanged: 0,
    consecutiveFailures: 0,
    lastLatencyMs: null
  });

  const fetcherRef = useRef(fetcher);
  const onDataRef = useRef(onData);
  const onErrorRef = useRef(onError);
  const getVersionRef = useRef(getVersion);
  // Holds the controller of the run that currently owns the single-flight slot.
  // Identity comparison against it is what makes ownership per-run.
  const activeRunRef = useRef(null);
  const timerRef = useRef(null);
  const mountedRef = useRef(true);
  const sequenceRef = useRef(0);
  const appliedSequenceRef = useRef(0);
  // Seeded so a caller that painted from a cache is not overwritten by an older read.
  const appliedVersionRef = useRef(initialVersion);
  const failuresRef = useRef(0);
  const runRef = useRef(null);
  const enabledRef = useRef(enabled);

  fetcherRef.current = fetcher;
  enabledRef.current = enabled;
  onDataRef.current = onData;
  onErrorRef.current = onError;
  getVersionRef.current = getVersion;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const nextDelay = useCallback(() => {
    if (failuresRef.current === 0) return interval;
    const backedOff = interval * backoffFactor ** failuresRef.current;
    return Math.min(backedOff, maxInterval);
  }, [interval, backoffFactor, maxInterval]);

  const schedule = useCallback(() => {
    clearTimer();
    if (!mountedRef.current) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      runRef.current?.();
    }, nextDelay());
  }, [clearTimer, nextDelay]);

  const run = useCallback(async ({ manual = false } = {}) => {
    if (!fetcherRef.current) return;
    if (!enabled && !manual) return;
    if (pauseWhenHidden && !isDocumentVisible() && !manual) {
      setStatus(POLL_STATUS.PAUSED);
      return;
    }
    if (activeRunRef.current) {
      if (!manual) schedule();
      return;
    }

    clearTimer();
    const controller = new AbortController();
    activeRunRef.current = controller;
    const sequence = ++sequenceRef.current;
    const startedAt = Date.now();

    setStatus((prev) => (prev === POLL_STATUS.IDLE ? POLL_STATUS.LOADING : prev));
    setMetrics((prev) => ({ ...prev, requests: prev.requests + 1 }));

    try {
      const payload = await fetcherRef.current(controller.signal);
      const latency = Date.now() - startedAt;
      if (!mountedRef.current || controller.signal.aborted) return;

      failuresRef.current = 0;

      if (payload === POLL_NO_CHANGE) {
        // A successful poll that found nothing new: leave the applied sequence and
        // version untouched so the next real payload is still compared against the data
        // actually on screen. `finally` arms the next poll as usual.
        setMetrics((prev) => ({
          ...prev,
          unchanged: prev.unchanged + 1,
          consecutiveFailures: 0,
          lastLatencyMs: latency
        }));
        setLastSyncAt(new Date());
        setError(null);
        setStatus(POLL_STATUS.LIVE);
        return;
      }

      const incomingVersion = getVersionRef.current ? getVersionRef.current(payload) : null;
      const stale =
        sequence < appliedSequenceRef.current ||
        (incomingVersion != null &&
          appliedVersionRef.current != null &&
          incomingVersion < appliedVersionRef.current);

      if (stale) {
        setMetrics((prev) => ({
          ...prev,
          discarded: prev.discarded + 1,
          consecutiveFailures: 0,
          lastLatencyMs: latency
        }));
      } else {
        appliedSequenceRef.current = sequence;
        if (incomingVersion != null) appliedVersionRef.current = incomingVersion;
        onDataRef.current?.(payload);
        setMetrics((prev) => ({
          ...prev,
          consecutiveFailures: 0,
          lastLatencyMs: latency
        }));
        setLastSyncAt(new Date());
      }

      setError(null);
      setStatus(POLL_STATUS.LIVE);
    } catch (err) {
      if (controller.signal.aborted || err?.name === 'AbortError') return;
      if (!mountedRef.current) return;

      failuresRef.current += 1;
      setMetrics((prev) => ({
        ...prev,
        failures: prev.failures + 1,
        consecutiveFailures: failuresRef.current,
        lastLatencyMs: Date.now() - startedAt
      }));
      setError(err);
      setStatus(POLL_STATUS.ERROR);
      onErrorRef.current?.(err);
    } finally {
      // Only the owning run may release the slot or arm the next timer: an aborted
      // run settling late must not schedule over a replacement that is still pending.
      if (activeRunRef.current === controller) {
        activeRunRef.current = null;
        const hidden = pauseWhenHidden && !isDocumentVisible();
        if (mountedRef.current && enabledRef.current && !hidden) schedule();
      }
    }
  }, [clearTimer, enabled, pauseWhenHidden, schedule]);

  runRef.current = run;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
      activeRunRef.current?.abort();
      activeRunRef.current = null;
    };
  }, [clearTimer]);

  useEffect(() => {
    if (!enabled) {
      clearTimer();
      activeRunRef.current?.abort();
      activeRunRef.current = null;
      setStatus(POLL_STATUS.PAUSED);
      return undefined;
    }

    if (immediate) {
      run();
    } else {
      schedule();
    }

    return clearTimer;
  }, [enabled, immediate, run, schedule, clearTimer]);

  useEffect(() => {
    if (!pauseWhenHidden || typeof document === 'undefined') return undefined;

    const handleVisibilityChange = () => {
      if (!enabled) return;
      if (isDocumentVisible()) {
        run();
      } else {
        clearTimer();
        activeRunRef.current?.abort();
        activeRunRef.current = null;
        setStatus(POLL_STATUS.PAUSED);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [pauseWhenHidden, enabled, run, clearTimer]);

  const refresh = useCallback(() => {
    // Abandon ownership as well as aborting: the abandoned run's `finally` now
    // no-ops, so the replacement started below owns the slot and the timer.
    activeRunRef.current?.abort();
    activeRunRef.current = null;
    failuresRef.current = 0;
    return run({ manual: true });
  }, [run]);

  return useMemo(() => ({
    status,
    error,
    metrics,
    lastSyncAt,
    isPaused: status === POLL_STATUS.PAUSED,
    refresh
  }), [status, error, metrics, lastSyncAt, refresh]);
}
