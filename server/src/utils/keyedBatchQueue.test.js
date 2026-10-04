import { describe, it, expect } from 'vitest';
import { createKeyedBatchQueue } from './keyedBatchQueue.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('createKeyedBatchQueue', () => {
  it('runs the first item alone and batches whatever arrives while it runs', async () => {
    const batches = [];
    const gate = deferred();
    const enqueue = createKeyedBatchQueue(async (key, items) => {
      batches.push(items);
      if (batches.length === 1) await gate.promise;
      return items.map((item) => ({ value: item * 10 }));
    });

    const results = [enqueue('k', 1), enqueue('k', 2), enqueue('k', 3)];
    gate.resolve();

    expect(await Promise.all(results)).toEqual([10, 20, 30]);
    expect(batches).toEqual([[1], [2, 3]]);
  });

  it('keeps arrival order within a batch', async () => {
    const gate = deferred();
    let second;
    const enqueue = createKeyedBatchQueue(async (key, items) => {
      if (items[0] === 'first') await gate.promise;
      else second = items;
      return items.map((value) => ({ value }));
    });

    const all = ['first', 'a', 'b', 'c', 'd'].map((item) => enqueue('k', item));
    gate.resolve();
    await Promise.all(all);
    expect(second).toEqual(['a', 'b', 'c', 'd']);
  });

  it('fails only the items whose outcome is an error', async () => {
    const enqueue = createKeyedBatchQueue(async (key, items) =>
      items.map((item) => (item === 'bad' ? { error: new Error('refused') } : { value: item }))
    );
    const gate = enqueue('k', 'warm');
    const [good, bad] = [enqueue('k', 'good'), enqueue('k', 'bad')];
    await gate;
    await expect(good).resolves.toBe('good');
    await expect(bad).rejects.toThrow('refused');
  });

  it('fails every item when the batch itself throws, and keeps serving afterwards', async () => {
    let calls = 0;
    const enqueue = createKeyedBatchQueue(async (key, items) => {
      calls += 1;
      if (calls === 1) throw new Error('database down');
      return items.map((value) => ({ value }));
    });

    await expect(enqueue('k', 1)).rejects.toThrow('database down');
    await expect(enqueue('k', 2)).resolves.toBe(2);
  });

  it('runs different keys independently', async () => {
    const gate = deferred();
    const enqueue = createKeyedBatchQueue(async (key, items) => {
      if (key === 'slow') await gate.promise;
      return items.map((value) => ({ value }));
    });

    const slow = enqueue('slow', 'x');
    await expect(enqueue('fast', 'y')).resolves.toBe('y');
    gate.resolve();
    await expect(slow).resolves.toBe('x');
  });

  it('caps a batch at maxBatch', async () => {
    const sizes = [];
    const gate = deferred();
    const enqueue = createKeyedBatchQueue(
      async (key, items) => {
        sizes.push(items.length);
        if (sizes.length === 1) await gate.promise;
        return items.map((value) => ({ value }));
      },
      { maxBatch: 2 }
    );
    const all = [1, 2, 3, 4, 5].map((n) => enqueue('k', n));
    gate.resolve();
    await Promise.all(all);
    expect(sizes).toEqual([1, 2, 2]);
  });

  it('rejects an item the batch returned no outcome for', async () => {
    const enqueue = createKeyedBatchQueue(async () => []);
    await expect(enqueue('k', 1)).rejects.toThrow('no outcome');
  });
});
