import apiClient from './api';

// Reusing a document's signed link while it is still good.
//
// A video's URL carries its signed link as `?access=`, and the browser caches the
// video's ranges under that URL. Signing a new link on every open made every URL
// new, so a grader reopening a video downloaded all of it again (~50 MB through
// Render each time). Handing back the same link makes the second open read from
// the browser's cache, and it starts sooner too: no round trip to sign first.
//
// A link is reused only while it has REUSE_MARGIN_MS of its 15 minutes left. The
// margin is how long a viewing can run on it before the preview's error handler
// has to re-sign mid-playback (hooks/useDocumentPreview.js), which costs a brief
// re-buffer.
//
// Kept in sessionStorage so a reload reuses it too. Entries are filed under the
// sign-in token they were issued to, so after a sign-out and a different sign-in
// in the same tab nobody is handed a link that acts as the previous person.

export const REUSE_MARGIN_MS = 3 * 60 * 1000;
const STORAGE_KEY = 'documentLinks';

const inFlight = new Map();
let memory = null;

function readStore() {
  if (memory) return memory;
  try {
    memory = JSON.parse(sessionStorage.getItem(STORAGE_KEY)) || {};
  } catch {
    memory = {};
  }
  return memory;
}

function writeStore() {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(memory));
  } catch {
    // Storage full or blocked: the in-memory copy still serves this page.
  }
}

// A short, non-reversible tag for the sign-in token, so the token itself is not
// copied into another storage slot. FNV-1a, twice with different seeds.
function sessionTag(token) {
  if (!token) return 'anon';
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let i = 0; i < token.length; i += 1) {
    const c = token.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x811c9dc5);
  }
  return `${(a >>> 0).toString(36)}${(b >>> 0).toString(36)}`;
}

// The link's own expiry, read from the JWT. Null when it cannot be read, and a
// link whose expiry is unknown is simply not reused.
function expiresAt(access) {
  try {
    const payload = access.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { exp } = JSON.parse(atob(payload));
    return Number.isFinite(exp) ? exp * 1000 : null;
  } catch {
    return null;
  }
}

/**
 * The `access` token for a document's link endpoint (from signedDocumentTarget).
 * Reuses one still good for REUSE_MARGIN_MS; `fresh: true` always signs anew,
 * which is what a link that just failed needs.
 */
export async function getDocumentLink(linkEndpoint, { fresh = false } = {}) {
  const key = `${sessionTag(apiClient.token)}|${linkEndpoint}`;
  const store = readStore();
  const now = Date.now();

  for (const [k, entry] of Object.entries(store)) {
    if (entry.expiresAt - REUSE_MARGIN_MS <= now) delete store[k];
  }
  if (!fresh && store[key]) return store[key].access;
  if (!fresh && inFlight.has(key)) return inFlight.get(key);

  const request = apiClient.post(linkEndpoint).then(({ access }) => {
    const expiry = expiresAt(access);
    if (expiry && expiry - REUSE_MARGIN_MS > Date.now()) {
      readStore()[key] = { access, expiresAt: expiry };
      writeStore();
    }
    return access;
  });
  inFlight.set(key, request);
  try {
    return await request;
  } finally {
    if (inFlight.get(key) === request) inFlight.delete(key);
  }
}

/** Forget every link. Called on sign-out. */
export function clearDocumentLinks() {
  memory = {};
  inFlight.clear();
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored, or storage blocked.
  }
}
