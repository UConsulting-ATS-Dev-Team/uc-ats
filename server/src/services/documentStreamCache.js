// Short-lived memory of the work every document range request repeats.
//
// A grading video arrives as a series of 4 MB ranges (services/byteRange.js), and
// each range used to re-run the access check (five unindexed `contains` scans over
// applications) and re-ask Drive for the file's size and type, about 0.65 s in
// series before Drive sent a byte. Most videos are iPhone .mov files at a high
// bitrate, where 4 MB is a few seconds of footage, so that wait on every range is
// what made playback stall. Both answers are the same for every range of one
// viewing, so the first range pays for them and the rest reuse them.

/** As long as a signed link's own 15 minutes would let a viewer keep reading. */
export const STREAM_CACHE_TTL_MS = 5 * 60 * 1000;
const MAX_ENTRIES = 1000;

const accessCache = new Map(); // `${userId}:${fileId}` -> { expiresAt, value: Promise<true> }
const metadataCache = new Map(); // fileId -> { expiresAt, value: Promise<metadata> }

/**
 * `compute()` once per key per TTL. The promise is stored, so ranges a browser
 * sends together (the start and the end of a file whose index sits last) share
 * one lookup. A rejection is never kept, and neither is a result `keep` refuses.
 */
function remember(cache, key, compute, keep = () => true) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  const value = Promise.resolve().then(compute);
  if (cache.size >= MAX_ENTRIES) {
    for (const [k, entry] of cache) if (entry.expiresAt <= now) cache.delete(k);
    // Still full of live entries: drop the oldest. Map keeps insertion order.
    if (cache.size >= MAX_ENTRIES) cache.delete(cache.keys().next().value);
  }
  cache.set(key, { expiresAt: now + STREAM_CACHE_TTL_MS, value });

  const forget = () => {
    if (cache.get(key)?.value === value) cache.delete(key);
  };
  value.then((result) => { if (!keep(result)) forget(); }, forget);
  return value;
}

/**
 * Only a grant is remembered. A refusal is re-checked on the next request, so a
 * document attached a moment ago is not refused for five minutes.
 */
export const rememberFileAccess = (userId, fileId, check) =>
  remember(accessCache, `${userId}:${fileId}`, check, (allowed) => allowed === true);

export const rememberFileMetadata = (fileId, fetch) =>
  remember(metadataCache, fileId, fetch);

/** Tests only. */
export function clearDocumentStreamCache() {
  accessCache.clear();
  metadataCache.clear();
}
