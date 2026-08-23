import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import usePolling, { POLL_STATUS, POLL_NO_CHANGE } from './usePolling';

// Fake timers make polling deterministic, so flush pending microtasks/timers
// explicitly instead of relying on waitFor.
async function flush() {
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
}

async function advance(ms) {
  await act(async () => { await vi.advanceTimersByTimeAsync(ms); });
}

function setVisibility(state) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}

describe('usePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches immediately and then on the configured interval', async () => {
    const fetcher = vi.fn().mockResolvedValue({ value: 1 });
    const onData = vi.fn();

    const { result } = renderHook(() => usePolling({ fetcher, interval: 1000, onData }));
    await flush();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onData).toHaveBeenCalledWith({ value: 1 });
    expect(result.current.status).toBe(POLL_STATUS.LIVE);
    expect(result.current.lastSyncAt).toBeInstanceOf(Date);

    await advance(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);

    await advance(1000);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('waits one interval before the first fetch when immediate is false', async () => {
    const fetcher = vi.fn().mockResolvedValue({});

    renderHook(() => usePolling({ fetcher, interval: 1000, immediate: false }));
    await flush();

    expect(fetcher).not.toHaveBeenCalled();
    await advance(1000);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps a single request in flight', async () => {
    const first = deferred();
    const fetcher = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValue({});
    const { result } = renderHook(() => usePolling({ fetcher, interval: 1000 }));
    await flush();

    expect(fetcher).toHaveBeenCalledTimes(1);

    await advance(3000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => { first.resolve({}); });
    await advance(1000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.metrics.requests).toBe(2);
  });

  it('pauses while the document is hidden and refetches when it becomes visible', async () => {
    const fetcher = vi.fn().mockResolvedValue({});
    const { result } = renderHook(() => usePolling({ fetcher, interval: 1000 }));
    await flush();

    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => { setVisibility('hidden'); });
    expect(result.current.isPaused).toBe(true);

    await advance(5000);
    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => { setVisibility('visible'); });
    await flush();
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(result.current.status).toBe(POLL_STATUS.LIVE);
  });

  it('does not poll while disabled', async () => {
    const fetcher = vi.fn().mockResolvedValue({});
    const { result } = renderHook(() => usePolling({ fetcher, interval: 1000, enabled: false }));

    await advance(5000);
    expect(fetcher).not.toHaveBeenCalled();
    expect(result.current.isPaused).toBe(true);
  });

  it('backs off exponentially on failure up to maxInterval and recovers', async () => {
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue({});
    const onError = vi.fn();
    const { result } = renderHook(() =>
      usePolling({ fetcher, interval: 1000, maxInterval: 2500, onError })
    );
    await flush();

    expect(result.current.status).toBe(POLL_STATUS.ERROR);
    expect(onError).toHaveBeenCalledTimes(1);

    // first retry waits interval * backoffFactor
    await advance(1999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // second retry would be interval * 4 but is capped at maxInterval
    await advance(2500);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(result.current.status).toBe(POLL_STATUS.LIVE);
    expect(result.current.error).toBeNull();
    expect(result.current.metrics.failures).toBe(2);
    expect(result.current.metrics.consecutiveFailures).toBe(0);
  });

  it('discards a response reporting an older server version than the applied one', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ updatedAt: 200 })
      .mockResolvedValueOnce({ updatedAt: 100 })
      .mockResolvedValueOnce({ updatedAt: 300 });
    const onData = vi.fn();
    const { result } = renderHook(() =>
      usePolling({ fetcher, interval: 1000, onData, getVersion: (p) => p.updatedAt })
    );
    await flush();

    expect(onData).toHaveBeenCalledWith({ updatedAt: 200 });

    await advance(1000);
    expect(onData).toHaveBeenCalledTimes(1);
    expect(result.current.metrics.discarded).toBe(1);
    expect(result.current.status).toBe(POLL_STATUS.LIVE);

    await advance(1000);
    expect(onData).toHaveBeenLastCalledWith({ updatedAt: 300 });
  });

  it('discards a response older than the version already on screen at mount', async () => {
    // Remount with a cached snapshot the caller has already painted (version 300): the
    // fresh hook must not accept the older read that comes back first.
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ updatedAt: 100 })
      .mockResolvedValueOnce({ updatedAt: 400 });
    const onData = vi.fn();
    const { result } = renderHook(() =>
      usePolling({ fetcher, interval: 1000, onData, initialVersion: 300, getVersion: (p) => p.updatedAt })
    );
    await flush();

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onData).not.toHaveBeenCalled();
    expect(result.current.metrics.discarded).toBe(1);

    await advance(1000);
    expect(onData).toHaveBeenCalledWith({ updatedAt: 400 });
  });

  it('discards a slow response after a newer one has been applied', async () => {
    const slow = deferred();
    const fetcher = vi.fn()
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValue({ updatedAt: 200 });
    const onData = vi.fn();
    const { result } = renderHook(() =>
      usePolling({ fetcher, interval: 1000, onData, getVersion: (p) => p.updatedAt })
    );
    await flush();

    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => { await result.current.refresh(); });
    expect(onData).toHaveBeenCalledWith({ updatedAt: 200 });

    await act(async () => { slow.resolve({ updatedAt: 100 }); });
    expect(onData).toHaveBeenCalledTimes(1);
  });

  it('does not let an aborted request schedule over its still-pending replacement', async () => {
    const aborted = deferred();
    const replacement = deferred();
    const fetcher = vi.fn()
      .mockReturnValueOnce(aborted.promise)
      .mockReturnValueOnce(replacement.promise)
      .mockResolvedValue({});

    const { result } = renderHook(() => usePolling({ fetcher, interval: 1000 }));
    await flush();

    await act(async () => { result.current.refresh(); });
    expect(fetcher).toHaveBeenCalledTimes(2);

    // The aborted first request settles late while the replacement is still pending.
    await act(async () => { aborted.resolve({}); });
    await advance(3000);
    expect(fetcher).toHaveBeenCalledTimes(2);

    // The replacement, which owns the slot, arms the next interval itself.
    await act(async () => { replacement.resolve({}); });
    await advance(1000);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it('treats POLL_NO_CHANGE as a successful poll that applies nothing', async () => {
    const onData = vi.fn();
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ v: 1 })
      .mockResolvedValue(POLL_NO_CHANGE);

    const { result } = renderHook(() =>
      usePolling({ fetcher, interval: 1000, onData, getVersion: (d) => d.v })
    );
    await flush();

    expect(onData).toHaveBeenCalledTimes(1);
    const firstSyncAt = result.current.lastSyncAt;

    await advance(1000);

    expect(fetcher).toHaveBeenCalledTimes(2);
    // Nothing new to show, but the poll succeeded: still live, still advancing.
    expect(onData).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe(POLL_STATUS.LIVE);
    expect(result.current.error).toBeNull();
    expect(result.current.metrics.unchanged).toBe(1);
    expect(result.current.metrics.discarded).toBe(0);
    expect(result.current.lastSyncAt).not.toBe(firstSyncAt);
  });

  it('keeps polling after POLL_NO_CHANGE and still applies the next real payload', async () => {
    const onData = vi.fn();
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ v: 1 })
      .mockResolvedValueOnce(POLL_NO_CHANGE)
      .mockResolvedValueOnce({ v: 2 });

    renderHook(() => usePolling({ fetcher, interval: 1000, onData, getVersion: (d) => d.v }));
    await flush();
    await advance(1000);
    await advance(1000);

    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(onData).toHaveBeenCalledTimes(2);
    // An unchanged poll must not disturb the applied version: v2 still counts as newer.
    expect(onData).toHaveBeenLastCalledWith({ v: 2 });
  });

  it('aborts the in-flight request on manual refresh and on unmount', async () => {
    const signals = [];
    const fetcher = vi.fn((signal) => {
      signals.push(signal);
      return new Promise(() => {});
    });

    const { result, unmount } = renderHook(() => usePolling({ fetcher, interval: 1000 }));
    await flush();

    expect(fetcher).toHaveBeenCalledTimes(1);

    await act(async () => { result.current.refresh(); });
    expect(signals[0].aborted).toBe(true);
    expect(signals).toHaveLength(2);
    expect(signals[1].aborted).toBe(false);

    unmount();
    expect(signals[1].aborted).toBe(true);
  });
});
