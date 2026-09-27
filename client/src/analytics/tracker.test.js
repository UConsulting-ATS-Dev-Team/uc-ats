import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { maskText, normalizePath } from './normalizePath';
import { FLUSH_AT, QUEUE_CAP, flush, getSessionId, queuedEvents, resetTracker, startTracker, track } from './tracker';
import { installPageTracking, resetPageTracking, trackRouteChange } from './pageTracking';

beforeEach(() => {
  resetTracker();
  resetPageTracking();
  sessionStorage.clear();
  localStorage.clear();
  globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true }));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const sentBatches = () => fetch.mock.calls.map(([, init]) => JSON.parse(init.body));

describe('normalizePath', () => {
  it('matches the server rules', () => {
    expect(normalizePath('/applications/3f2b8c1e-9a4d-4e6f-8b2a-1c3d5e7f9a0b')).toBe('/applications/:id');
    expect(normalizePath('/cycles/42/')).toBe('/cycles/:id');
    expect(normalizePath('/reset-password?token=secret')).toBe('/reset-password');
    expect(normalizePath('/talent/joe%40ucla.edu')).toBe('/talent/:email');
  });

  it('masks addresses in text', () => {
    expect(maskText('Email  joe@ucla.edu now', 60)).toBe('Email [email] now');
    expect(maskText('x'.repeat(80), 10)).toHaveLength(10);
  });
});

describe('tracker', () => {
  it('only queues until started', () => {
    track('click', { name: 'Save' });
    flush();
    expect(fetch).not.toHaveBeenCalled();
    expect(queuedEvents()).toHaveLength(1);
  });

  it('sends a text/plain batch with the session id and the bearer token', () => {
    localStorage.setItem('token', 'jwt-abc');
    startTracker();
    track('click', { path: '/admin/users/12', name: 'Save' });
    flush();
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe('/api/analytics/events');
    expect(init.keepalive).toBe(true);
    expect(init.headers).toEqual({ 'Content-Type': 'text/plain', Authorization: 'Bearer jwt-abc' });
    const body = JSON.parse(init.body);
    expect(body.sessionId).toBe(getSessionId());
    expect(body.events[0]).toMatchObject({ type: 'click', path: '/admin/users/:id', name: 'Save' });
  });

  it('sends each event under the session it happened in', () => {
    startTracker();
    track('page_view', { path: '/login' });
    localStorage.setItem('token', 'jwt-new');
    track('page_view', { path: '/dashboard' });
    flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    const [[, first], [, second]] = fetch.mock.calls;
    expect(first.headers.Authorization).toBeUndefined();
    expect(JSON.parse(first.body).events.map((e) => e.path)).toEqual(['/login']);
    expect(second.headers.Authorization).toBe('Bearer jwt-new');
    expect(JSON.parse(second.body).events.map((e) => e.path)).toEqual(['/dashboard']);
  });

  it('flushes on its own once enough events wait', () => {
    startTracker();
    for (let i = 0; i < FLUSH_AT; i += 1) track('click', { name: `b${i}` });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('flushes when the page is hidden', () => {
    startTracker();
    track('page_view');
    window.dispatchEvent(new Event('pagehide'));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to sendBeacon when fetch throws', () => {
    fetch.mockImplementation(() => {
      throw new TypeError('keepalive unsupported');
    });
    navigator.sendBeacon = vi.fn(() => true);
    startTracker();
    track('page_view');
    flush();
    expect(navigator.sendBeacon).toHaveBeenCalledWith('/api/analytics/events', expect.any(Blob));
  });

  it('keeps at most QUEUE_CAP events, dropping the oldest', () => {
    for (let i = 0; i < QUEUE_CAP + 5; i += 1) track('click', { name: `b${i}` });
    const queued = queuedEvents();
    expect(queued).toHaveLength(QUEUE_CAP);
    expect(queued[0].name).toBe('b5');
  });

  it('never throws, even when fetch rejects', async () => {
    fetch.mockImplementation(() => Promise.reject(new Error('offline')));
    startTracker();
    expect(() => {
      track('page_view');
      flush();
    }).not.toThrow();
  });

  it('does nothing when switched off', () => {
    vi.stubEnv('VITE_ANALYTICS_DISABLED', '1');
    track('page_view');
    expect(queuedEvents()).toHaveLength(0);
  });

  it('keeps one session id per tab', () => {
    const id = getSessionId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(sessionStorage.getItem('uc-ats:analytics-session')).toBe(id);
  });
});

describe('trackRouteChange', () => {
  it('records a view, and the previous page time when leaving it', () => {
    trackRouteChange('/dashboard', 1_000);
    trackRouteChange('/cycles/7', 6_000);
    const events = queuedEvents();
    expect(events.map((e) => e.type)).toEqual(['page_view', 'page_dwell', 'page_view']);
    expect(events[1]).toMatchObject({ path: '/dashboard', value: 5_000 });
    expect(events[2]).toMatchObject({ path: '/cycles/:id' });
  });

  it('records the last page once when a tab close fires both hide events', () => {
    installPageTracking();
    startTracker();
    trackRouteChange('/dashboard', Date.now() - 5000);
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
    const dwell = sentBatches().flatMap((b) => b.events).filter((e) => e.type === 'page_dwell');
    expect(dwell).toHaveLength(1);
    expect(dwell[0].value).toBeGreaterThanOrEqual(5000);
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('ignores a change that normalizes to the same page', () => {
    trackRouteChange('/cycles/7', 1_000);
    trackRouteChange('/cycles/8', 2_000);
    expect(queuedEvents()).toHaveLength(1);
  });
});
