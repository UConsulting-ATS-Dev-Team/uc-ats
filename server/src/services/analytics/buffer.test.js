import { describe, it, expect, vi, afterEach } from 'vitest';

import { createBuffer, flushAll } from './buffer.js';

vi.mock('./log.js', () => ({ logError: vi.fn() }));

const buffers = [];
const make = (opts) => {
  const b = createBuffer({ name: 'test', intervalMs: 0, ...opts });
  buffers.push(b);
  return b;
};

afterEach(() => {
  for (const b of buffers.splice(0)) b.reset();
  delete process.env.ANALYTICS_DISABLED;
  vi.useRealTimers();
});

describe('createBuffer', () => {
  it('writes a batch as soon as flushAt rows are waiting', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const b = make({ write, flushAt: 3 });
    b.push({ n: 1 });
    b.push({ n: 2 });
    expect(write).not.toHaveBeenCalled();
    b.push({ n: 3 });
    await b.flush();
    expect(write).toHaveBeenCalledWith([{ n: 1 }, { n: 2 }, { n: 3 }]);
    expect(b.size()).toBe(0);
  });

  it('writes on the timer', async () => {
    vi.useFakeTimers();
    const write = vi.fn().mockResolvedValue(undefined);
    const b = make({ write, intervalMs: 1000 });
    b.push({ n: 1 });
    await vi.advanceTimersByTimeAsync(1000);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('drops the oldest row at the cap and reports the loss after the next good write', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const onDropped = vi.fn();
    const b = make({ write, cap: 2, flushAt: 100, onDropped });
    b.push({ n: 1 });
    b.push({ n: 2 });
    b.push({ n: 3 });
    await b.flush();
    expect(write).toHaveBeenCalledWith([{ n: 2 }, { n: 3 }]);
    expect(onDropped).toHaveBeenCalledWith(1, 'test');
  });

  it('swallows a failed write and counts the batch as dropped', async () => {
    const write = vi.fn().mockRejectedValueOnce(new Error('db down')).mockResolvedValue(undefined);
    const onDropped = vi.fn();
    const b = make({ write, flushAt: 100, onDropped });
    b.push({ n: 1 });
    await expect(b.flush()).resolves.toBe(0);
    b.push({ n: 2 });
    await b.flush();
    expect(onDropped).toHaveBeenCalledWith(1, 'test');
  });

  it('never throws from push, even when the write throws synchronously', async () => {
    const b = make({
      write: () => {
        throw new Error('boom');
      },
      flushAt: 1,
    });
    expect(() => b.push({ n: 1 })).not.toThrow();
    await b.flush();
  });

  it('runs one write at a time', async () => {
    let release;
    const write = vi.fn(() => new Promise((r) => (release = r)));
    const b = make({ write, flushAt: 100 });
    b.push({ n: 1 });
    const first = b.flush();
    b.push({ n: 2 });
    expect(b.flush()).toBe(first);
    await vi.waitFor(() => expect(write).toHaveBeenCalled());
    release();
    await first;
    expect(write).toHaveBeenCalledTimes(1);
    expect(b.size()).toBe(1);
  });

  it('knows whether a row is still waiting', async () => {
    const b = make({ write: vi.fn().mockResolvedValue(undefined), flushAt: 100 });
    const row = { n: 1 };
    b.push(row);
    expect(b.has(row)).toBe(true);
    await b.flush();
    expect(b.has(row)).toBe(false);
  });

  it('does nothing when analytics is switched off', () => {
    process.env.ANALYTICS_DISABLED = '1';
    const b = make({ write: vi.fn(), flushAt: 100 });
    b.push({ n: 1 });
    expect(b.size()).toBe(0);
  });

  it('flushAll waits for every buffer', async () => {
    const a = vi.fn().mockResolvedValue(undefined);
    const c = vi.fn().mockRejectedValue(new Error('x'));
    make({ write: a, flushAt: 100 }).push({ n: 1 });
    make({ write: c, flushAt: 100 }).push({ n: 2 });
    await expect(flushAll()).resolves.toBeUndefined();
    expect(a).toHaveBeenCalled();
    expect(c).toHaveBeenCalled();
  });
});
