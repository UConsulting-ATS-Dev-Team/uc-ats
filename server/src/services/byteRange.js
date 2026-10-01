// HTTP Range requests (RFC 9110 §14) for documents we stream from Drive.
//
// A grading video is too large to arrive in one response: /api reaches this server
// through Vercel's rewrite proxy, which cuts long responses off, and the preview
// failed with "The download stopped before the file finished". A <video> element
// asks for ranges instead ("bytes=0-", then from wherever each answer ended), so
// answering each one with at most MAX_RANGE_BYTES keeps every response short and
// lets playback and seeking start before the whole file has been read.

/** The most one range response carries. Open-ended requests are cut to this. */
export const MAX_RANGE_BYTES = 4 * 1024 * 1024;

/**
 * The byte range to serve for a `Range` header against a file of `size` bytes.
 *
 * - `{ start, end }` (inclusive): answer 206 with that slice.
 * - `'unsatisfiable'`: answer 416.
 * - `null`: no range to honour - no header, an unknown size, several ranges, or a
 *   header this does not understand. Serve the whole file with 200, which the RFC
 *   allows for any Range a server chooses to ignore.
 */
export function parseByteRange(header, size, maxBytes = MAX_RANGE_BYTES) {
  if (typeof header !== 'string' || header.trim() === '') return null;
  if (!Number.isFinite(size) || size < 0) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, first, last] = match;
  if (first === '' && last === '') return null;

  let start;
  let end;
  if (first === '') {
    // Suffix: the last `last` bytes.
    const length = Number(last);
    if (length === 0 || size === 0) return 'unsatisfiable';
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    start = Number(first);
    end = last === '' ? size - 1 : Number(last);
    if (last !== '' && end < start) return null;
    if (start >= size) return 'unsatisfiable';
    end = Math.min(end, size - 1);
  }

  if (end - start + 1 <= maxBytes) return { start, end };
  // A suffix asks for the end of the file (a video's index often sits there), so
  // a capped suffix keeps the last bytes; any other range keeps its start.
  return first === ''
    ? { start: end - maxBytes + 1, end }
    : { start, end: start + maxBytes - 1 };
}
