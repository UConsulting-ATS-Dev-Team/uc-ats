// Run an async function over a list with a bounded number in flight.
//
// The bulk senders use this so a few hundred emails neither go one at a time
// (slow enough for the proxy in front of /api to cut the response off) nor all
// at once (which SES throttles).

/**
 * `fn(item)` for every item, at most `concurrency` at a time. Resolves to the
 * results in input order. If one call rejects, the whole thing rejects with
 * that error, so a caller that must not stop catches inside `fn`.
 */
export async function mapWithConcurrency(items, fn, concurrency = 5) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}
