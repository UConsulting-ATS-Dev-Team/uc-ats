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

export default toSameOriginDocumentUrl;
