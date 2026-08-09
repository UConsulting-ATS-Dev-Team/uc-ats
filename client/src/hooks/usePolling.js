import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

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
 * - every request is cancellable and is aborted on unmount, disable, or manual refresh
 * - polling pauses while the document is hidden and resumes with an immediate fetch
 * - failures back off exponentially up to `maxInterval` and surface as visible state
 * - a response is discarded when a newer response has already been applied, either by
 *   arrival order or by `getVersion` (server `updatedAt`/version semantics)
 *
 * @param {(signal: AbortSignal) => Promise<any>} options.fetcher
 * @param {number} [options.interval] base interval in ms
 * @param {boolean} [options.enabled] pause polling entirely when false
 * @param {boolean} [options.immediate] fetch on mount instead of after one interval
 * @param {boolean} [options.pauseWhenHidden] pause while the tab/page is hidden
 * @param {number} [options.maxInterval] backoff ceiling in ms
 * @param {(payload: any) => number|string|null} [options.getVersion] monotonic server version
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
    consecutiveFailures: 0,
    lastLatencyMs: null
  });

  const fetcherRef = useRef(fetcher);
  const onDataRef = useRef(onData);
  const onErrorRef = useRef(onError);
  const getVersionRef = useRef(getVersion);
  const inFlightRef = useRef(false);
  const controllerRef = useRef(null);
  const timerRef = useRef(null);
  const mountedRef = useRef(true);
  const sequenceRef = useRef(0);
  const appliedSequenceRef = useRef(0);
  const appliedVersionRef = useRef(null);
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
    if (inFlightRef.current) {
      if (!manual) schedule();
      return;
    }

    clearTimer();
    inFlightRef.current = true;
    const controller = new AbortController();
    controllerRef.current = controller;
    const sequence = ++sequenceRef.current;
    const startedAt = Date.now();

    setStatus((prev) => (prev === POLL_STATUS.IDLE ? POLL_STATUS.LOADING : prev));
    setMetrics((prev) => ({ ...prev, requests: prev.requests + 1 }));

    try {
      const payload = await fetcherRef.current(controller.signal);
      const latency = Date.now() - startedAt;
      if (!mountedRef.current || controller.signal.aborted) return;

      failuresRef.current = 0;

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
      inFlightRef.current = false;
      if (controllerRef.current === controller) controllerRef.current = null;
      if (mountedRef.current && enabledRef.current) schedule();
    }
  }, [clearTimer, enabled, pauseWhenHidden, schedule]);

  runRef.current = run;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearTimer();
      controllerRef.current?.abort();
      controllerRef.current = null;
      inFlightRef.current = false;
    };
  }, [clearTimer]);

  useEffect(() => {
    if (!enabled) {
      clearTimer();
      controllerRef.current?.abort();
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
        controllerRef.current?.abort();
        setStatus(POLL_STATUS.PAUSED);
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
  }, [pauseWhenHidden, enabled, run, clearTimer]);

  const refresh = useCallback(() => {
    controllerRef.current?.abort();
    inFlightRef.current = false;
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
