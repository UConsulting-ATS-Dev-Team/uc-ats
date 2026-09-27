import { normalizePath } from './normalizePath';
import { onPageHide, track } from './tracker';

// A page view per route change, and how long the previous page was open
// (page_dwell). Called from AppRoutes whenever the pathname changes.

let current = null;
let since = 0;

function closeCurrent(now) {
  if (current && since) track('page_dwell', { path: current, value: now - since });
}

export function trackRouteChange(pathname, now = Date.now()) {
  try {
    const path = normalizePath(pathname);
    if (path === current) return;
    closeCurrent(now);
    current = path;
    since = now;
    track('page_view', { path });
  } catch {
    // never break navigation
  }
}

let installed = false;

/** The last page's dwell is sent when the tab is closed or backgrounded. */
export function installPageTracking() {
  if (installed) return;
  installed = true;
  onPageHide(() => {
    const now = Date.now();
    closeCurrent(now);
    // Time in the background is not time on the page.
    since = now;
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') since = Date.now();
  });
}

/** Tests only. */
export function resetPageTracking() {
  current = null;
  since = 0;
}
