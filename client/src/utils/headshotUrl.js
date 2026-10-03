import { toSameOriginDocumentUrl } from './documentUrl';

// Short-edge sizes the server renders headshots at (server/src/services/headshotThumbnails.js).
export const HEADSHOT_SIZES = [256, 640];

// Device pixels per CSS pixel to stay sharp for: phones are 3x.
const DENSITY = 3;

const HEADSHOT_PATH = /^\/api\/files\/[^/?#]+\/image$/;

/**
 * The URL to draw a headshot at `displayPx` CSS pixels square.
 *
 * A stored headshot URL serves the applicant's original upload, about 0.8 MB,
 * to fill a 40 px circle. For our own `/api/files/<id>/image` URLs this asks
 * for the smallest server-rendered copy that is still sharp at that size on a
 * 3x screen, and for the original when nothing smaller is. Anything else (a
 * Drive link, a public storage URL) is returned as it is.
 *
 * Preloading and drawing must ask for the same size, or the preload is wasted:
 * the image cache is keyed by URL.
 */
export function headshotSrc(url, displayPx) {
  const local = toSameOriginDocumentUrl(url);
  if (typeof local !== 'string') return url;
  const [path, query = ''] = local.split('?');
  if (!HEADSHOT_PATH.test(path)) return url;

  const size = HEADSHOT_SIZES.find((s) => s >= displayPx * DENSITY);
  if (!size) return local;

  const params = new URLSearchParams(query);
  params.set('size', String(size));
  return `${path}?${params}`;
}

export default headshotSrc;
