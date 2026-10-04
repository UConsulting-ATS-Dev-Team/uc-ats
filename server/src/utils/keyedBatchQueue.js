// Run work for the same key one batch at a time, in arrival order.
//
// Built for a burst of requests that must serialise on one database lock. Left
// to themselves, each request opens a transaction and waits on the lock while
// holding a pooled connection, so ninety of them exhaust a pool of twenty and
// starve every other route. Queued here instead, they wait in memory, and
// whoever arrived while a batch was running goes into the next one together.
//
// This is a per-process optimisation, not the guarantee. Another server
// instance has its own queue; the database lock is still what keeps two of them
// apart.

/**
 * @param {(key: string, items: any[]) => Promise<Array<{ value?: any, error?: any }>>} runBatch
 *   Returns one outcome per item, in the same order. Throwing fails every item.
 * @param {{ maxBatch?: number }} [options]
 * @returns {(key: string, item: any) => Promise<any>}
 */
export function createKeyedBatchQueue(runBatch, { maxBatch = 100 } = {}) {
  const queues = new Map();

  async function drain(key, state) {
    while (state.pending.length > 0) {
      const batch = state.pending.splice(0, maxBatch);
      let outcomes;
      try {
        outcomes = await runBatch(
          key,
          batch.map((entry) => entry.item)
        );
      } catch (error) {
        outcomes = batch.map(() => ({ error }));
      }
      batch.forEach((entry, i) => {
        const outcome = outcomes?.[i];
        if (!outcome) entry.reject(new Error('Batch returned no outcome for this item'));
        else if ('error' in outcome) entry.reject(outcome.error);
        else entry.resolve(outcome.value);
      });
    }
    queues.delete(key);
  }

  return function enqueue(key, item) {
    return new Promise((resolve, reject) => {
      let state = queues.get(key);
      const idle = !state;
      if (idle) {
        state = { pending: [] };
        queues.set(key, state);
      }
      state.pending.push({ item, resolve, reject });
      if (idle) drain(key, state);
    });
  };
}
