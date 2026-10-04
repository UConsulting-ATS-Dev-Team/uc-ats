import { describe, it, expect } from 'vitest';
import { limitConcurrency } from './limitConcurrency.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

describe('limitConcurrency', () => {
  it('never runs more than the limit at once', async () => {
    const run = limitConcurrency(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
    };
    await Promise.all(Array.from({ length: 10 }, () => run(task)));
    expect(peak).toBe(2);
  });

  it('starts work in arrival order', async () => {
    const run = limitConcurrency(1);
    const started = [];
    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        run(async () => {
          started.push(n);
          await tick();
        })
      )
    );
    expect(started).toEqual([1, 2, 3, 4]);
  });

  it('passes results and errors through, and keeps going after a failure', async () => {
    const run = limitConcurrency(1);
    const failed = run(async () => {
      throw new Error('boom');
    });
    const ok = run(async () => 'fine');
    await expect(failed).rejects.toThrow('boom');
    await expect(ok).resolves.toBe('fine');
  });

  it('treats a synchronous throw like a rejection', async () => {
    const run = limitConcurrency(1);
    await expect(
      run(() => {
        throw new Error('sync');
      })
    ).rejects.toThrow('sync');
    await expect(run(async () => 1)).resolves.toBe(1);
  });
});
