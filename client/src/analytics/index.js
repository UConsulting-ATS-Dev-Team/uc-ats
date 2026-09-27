import { onCLS, onINP, onLCP, onTTFB } from 'web-vitals';

import { installClickTracking } from './clickTracking';
import { installErrorTracking } from './errorTracking';
import { installPageTracking } from './pageTracking';
import { analyticsDisabled, startTracker, track } from './tracker';

export { track } from './tracker';
export { trackRouteChange } from './pageTracking';
export { reportError } from './errorTracking';

// Core Web Vitals for the Performance tab: how fast the page paints (LCP),
// how fast it answers a tap (INP), how much it jumps around (CLS) and how fast
// the server starts answering (TTFB). The library reports each once it is
// final, which for INP and CLS is when the page is hidden.
function installVitals() {
  const report = (metric) => track('vital', { name: metric.name, value: metric.value });
  onLCP(report);
  onINP(report);
  onCLS(report);
  onTTFB(report);
}

/** Called once from main.jsx. */
export function initAnalytics() {
  try {
    if (analyticsDisabled()) return;
    startTracker();
    installPageTracking();
    installClickTracking();
    installErrorTracking();
    installVitals();
  } catch {
    // Analytics never stops the app from starting.
  }
}
