// Document URLs (`Application.resumeUrl`, `coverLetterUrl`, `videoUrl`,
// `headshotUrl`) are stored as whole strings, and historically some rows were
// written with an absolute origin baked in — production rows point at
// https://uconsultingats.com, older local rows at http://localhost:3001. Served
// from a different origin than the one that wrote them, fetching such a URL is
// a cross-origin request the API does not permit, and the browser blocks it at
// preflight:
//
//   Access to fetch at 'https://uconsultingats.com/api/files/<id>/pdf' from
//   origin 'http://localhost:5173' has been blocked by CORS policy
//
// Every endpoint that serves one of our documents lives under `/api` on the
// same origin as the app, so reducing the URL to a path lets the current origin
// (Vite's dev proxy, or the deployed host) route it. Matching on the path
// rather than a list of known hostnames keeps preview and staging origins
// working without an edit here.
//
// Anything that is not one of our own `/api` paths — a Google Drive link, say —
// is returned untouched, because it genuinely does live somewhere else.
export function toSameOriginDocumentUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') return url;

  let parsed;
  try {
    // The base makes already-relative URLs parse; it is discarded below.
    parsed = new URL(url, window.location.origin);
  } catch {
    return url;
  }

  if (parsed.pathname !== '/api' && !parsed.pathname.startsWith('/api/')) return url;

  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

// Documents served behind sign-in: a Drive file, or a replacement resume.
const SIGNED_PATHS = [
  /^\/api(\/files\/[^/?#]+)\/(?:pdf|image)$/,
  /^\/api(\/resume-uploads\/[^/?#]+)\/file$/,
];

/**
 * For one of our own documents, the endpoint that signs a link to it (relative
 * to apiClient's `/api` base) and the path to open with that link. Null for
 * anything else, which a plain link already opens.
 *
 * Sign-in travels as a header, which a new tab never sends, so a bare
 * `/api/files/<id>/pdf` in a new tab answers "Authentication required".
 */
export function signedDocumentTarget(url) {
  const local = toSameOriginDocumentUrl(url);
  if (typeof local !== 'string') return null;
  const path = local.split(/[?#]/)[0];
  const match = SIGNED_PATHS.map((pattern) => pattern.exec(path)).find(Boolean);
  if (!match) return null;
  return {
    linkEndpoint: `${match[1]}/link`,
    open: (access) => `${path}?access=${encodeURIComponent(access)}`,
  };
}

export default toSameOriginDocumentUrl;
