// Small copies of headshots, for avatars.
//
// A headshot is whatever the applicant uploaded to the form: a phone photo of
// about 0.8 MB on average, sometimes 10 MB. The lists draw it at 32-64 px and
// preload one per applicant, so a list of 300 applicants downloaded about
// 240 MB of photos to show 300 small circles.
//
// `GET /api/files/:id/image?size=<n>` asks for a copy whose *short* edge is n
// pixels (a square avatar with object-fit: cover crops the long edge, so the
// short edge is the one that has to be sharp). The sizes are a fixed list so
// a caller cannot make the server render and keep any size it likes.
//
// Rendered on first request and kept in memory, rather than at ingest: Drive is
// still the only copy of the original, nothing has to be backfilled, and a
// restart only costs each headshot one more Drive fetch and resize. The
// browser keeps the answer for a week (routes/files.js), which is what saves a
// returning admin the fetch, not this cache.

import sharp from 'sharp';

/**
 * Short-edge sizes the route will render.
 *
 * 256 covers every list avatar (64 px at 3x is 192). 640 covers the large
 * circles - the live vote spotlight (180 px) and the candidate page (120 px) -
 * at 3x. Anything shown bigger asks for the original.
 */
export const THUMBNAIL_SIZES = Object.freeze([256, 640]);

/** WebP at this quality is indistinguishable from the original at avatar size. */
const WEBP_QUALITY = 82;

/**
 * Originals larger than this are not decoded: the route streams them as it
 * always has. The largest headshot on record is 9.5 MB.
 */
export const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

/** About 1,500 thumbnails at 256 px, or a few hundred at 640. */
const CACHE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Drive downloads and resizes run at most this many at a time. A list page
 * asks for every applicant's headshot at once, and with a cold cache each one
 * holds its whole original in memory until it is resized; unbounded, 300 of
 * them is 240 MB on a 512 MB instance.
 */
const MAX_CONCURRENT_RENDERS = 12;

/** `?size=` as a number from THUMBNAIL_SIZES, null when absent, false when not allowed. */
export function parseThumbnailSize(raw) {
  if (raw === undefined || raw === '') return null;
  const size = Number(raw);
  return THUMBNAIL_SIZES.includes(size) ? size : false;
}

/**
 * Resize an image so its short edge is `size` px, as WebP.
 *
 * EXIF orientation is applied first (phone photos are stored sideways and
 * rotated by a flag), because WebP output carries no EXIF and would otherwise
 * come out on its side. Images already smaller than `size` are re-encoded but
 * never enlarged.
 *
 * Returns null when sharp cannot decode the file (HEIC from an iPhone, a PDF
 * someone uploaded as a photo), so the caller can fall back to the original.
 */
export async function renderThumbnail(buffer, size) {
  try {
    const body = await sharp(buffer, { failOn: 'none' })
      .rotate()
      .resize(size, size, { fit: 'outside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toBuffer();
    return { body, contentType: 'image/webp' };
  } catch {
    return null;
  }
}

const ascii = (buf, at, text) => buf.toString('latin1', at, at + text.length) === text;

/**
 * Do these first bytes start a format sharp's prebuilt binaries decode?
 * JPEG, PNG, GIF, WebP, TIFF and AVIF. Notably not HEIC (iPhone photos) or PDF,
 * which are the two kinds of "headshot" that turn up in practice.
 */
export function looksLikeReadableImage(head) {
  if (!head || head.length < 12) return false;
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return true; // JPEG
  if (head.readUInt32BE(0) === 0x89504e47) return true; // PNG
  if (ascii(head, 0, 'GIF8')) return true;
  if (ascii(head, 0, 'RIFF') && ascii(head, 8, 'WEBP')) return true;
  if (ascii(head, 0, 'II*\0') || ascii(head, 0, 'MM\0*')) return true; // TIFF
  if (ascii(head, 4, 'ftyp') && (ascii(head, 8, 'avif') || ascii(head, 8, 'avis'))) return true;
  return false;
}

const SNIFF_BYTES = 12;

/**
 * Read a stream into one Buffer. Gives up, closing the stream, past `limit`
 * bytes or when `accept(firstBytes)` refuses what the file starts with, so a
 * file that will not be decoded costs one chunk rather than a whole download.
 */
export async function readStreamToBuffer(stream, { limit = MAX_SOURCE_BYTES, accept } = {}) {
  const chunks = [];
  let total = 0;
  let checked = !accept;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > limit) {
      stream.destroy?.();
      return null;
    }
    chunks.push(chunk);
    if (!checked && total >= SNIFF_BYTES) {
      checked = true;
      if (!accept(Buffer.concat(chunks))) {
        stream.destroy?.();
        return null;
      }
    }
  }
  if (!checked && !accept(Buffer.concat(chunks))) return null;
  return Buffer.concat(chunks);
}

// --- bounded concurrency -----------------------------------------------------

let running = 0;
const waiting = [];

async function withRenderSlot(task) {
  if (running < MAX_CONCURRENT_RENDERS) {
    running += 1;
  } else {
    // The slot is handed over by the render that finishes, still counted, so a
    // request arriving in between cannot take it as well.
    await new Promise((resolve) => waiting.push(resolve));
  }
  try {
    return await task();
  } finally {
    const next = waiting.shift();
    if (next) next();
    else running -= 1;
  }
}

/** Tests only: renders running now, and waiting for a slot. */
export const renderSlotsForTest = () => ({ running, waiting: waiting.length, max: MAX_CONCURRENT_RENDERS });

// --- cache ---------------------------------------------------------------------

const cache = new Map(); // `${fileId}:${size}` -> thumbnail result, oldest first
let cachedBytes = 0;
const inFlight = new Map(); // same key -> Promise
// Files that could not be thumbnailed. Remembered so a HEIC headshot is not
// downloaded twice on every request (once here, once more as the original).
const unrenderable = new Set();
const MAX_UNRENDERABLE = 2000;

function remember(key, value) {
  if (value.body.length > CACHE_MAX_BYTES) return;
  cache.set(key, value);
  cachedBytes += value.body.length;
  while (cachedBytes > CACHE_MAX_BYTES) {
    const [oldestKey, oldest] = cache.entries().next().value;
    cache.delete(oldestKey);
    cachedBytes -= oldest.body.length;
  }
}

function recall(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  // Move to the back: Map iteration order doubles as least-recently-used.
  cache.delete(key);
  cache.set(key, hit);
  return hit;
}

/**
 * The thumbnail of one file at one size, `{ body, contentType }`, or null when
 * the caller should serve the original instead: not a format sharp reads (an
 * iPhone HEIC, a PDF uploaded as a photo), or too large to decode.
 *
 * The format is judged from the first bytes, and the download stops there, so
 * serving a HEIC's original afterwards does not fetch it twice. Only a file
 * that claims a readable format and then fails to decode costs a second
 * download, once. Nothing is kept in memory for the caller to send.
 *
 * `download(fileId)` returns a readable stream of the original. It is passed in
 * so this module never decides where files live or who may read them: the
 * route has already settled access before calling this.
 *
 * Requests for the same thumbnail that arrive together share one download.
 * A null result is remembered until restart (a Drive file id's content does not
 * change); a Drive error is thrown to the caller and not remembered.
 */
export function getHeadshotThumbnail(fileId, size, { download }) {
  const key = `${fileId}:${size}`;
  if (unrenderable.has(key)) return Promise.resolve(null);
  const hit = recall(key);
  if (hit) return Promise.resolve(hit);
  if (inFlight.has(key)) return inFlight.get(key);

  const pending = withRenderSlot(async () => {
    const original = await readStreamToBuffer(await download(fileId), { accept: looksLikeReadableImage });
    if (!original) return null;
    return renderThumbnail(original, size);
  })
    .then((result) => {
      if (result) remember(key, result);
      else if (unrenderable.size < MAX_UNRENDERABLE) unrenderable.add(key);
      return result;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, pending);
  return pending;
}

/** Tests only. */
export function clearHeadshotThumbnailCache() {
  cache.clear();
  inFlight.clear();
  unrenderable.clear();
  cachedBytes = 0;
}
