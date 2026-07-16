import { useEffect, useState } from 'react';

// Global "candidate preview" flag. Preview mode is LOCAL to each device (it never
// syncs), but it must gate global notification surfaces — chat, confetti, any
// toast/sound — so nothing can pop over the exhibit while the candidate is
// looking at the screen. Kept as a module singleton so non-React code (e.g. the
// celebration trigger) can check it synchronously.
let active = false;
const listeners = new Set();

export function isPreviewActive() {
  return active;
}

export function setPreviewActive(value) {
  active = !!value;
  listeners.forEach((l) => {
    try {
      l(active);
    } catch {
      /* ignore listener errors */
    }
  });
}

export function subscribePreview(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// React hook: re-renders when preview mode toggles.
export function usePreviewActive() {
  const [a, setA] = useState(active);
  useEffect(() => subscribePreview(setA), []);
  return a;
}
