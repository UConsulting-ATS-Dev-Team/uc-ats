import { maskText } from './normalizePath';
import { track } from './tracker';

// Browser errors nobody caught, for the Errors tab. The same message on the
// same page inside DEDUPE_MS is reported once, so a render loop throwing a
// thousand times costs one event.

const DEDUPE_MS = 5000;
const MESSAGE_MAX = 200;
const recent = new Map();

export function reportError(message, meta = {}) {
  try {
    const name = maskText(message || 'Unknown error', MESSAGE_MAX);
    const key = `${window.location.pathname}|${name}`;
    const now = Date.now();
    if (now - (recent.get(key) || 0) < DEDUPE_MS) return;
    recent.set(key, now);
    if (recent.size > 100) recent.delete(recent.keys().next().value);
    track('js_error', { name, meta });
  } catch {
    // reporting an error must not raise another
  }
}

let installed = false;

export function installErrorTracking() {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (event) => {
    // A failed <img>/<script> load also fires 'error', without a message.
    if (!event.message) return;
    reportError(event.message, { source: 'window', line: event.lineno || null });
  });
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    reportError(reason?.message || String(reason), { source: 'promise' });
  });
}

/** Tests only. */
export const resetErrorTracking = () => recent.clear();
