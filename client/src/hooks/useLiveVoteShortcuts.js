import { useEffect, useRef } from 'react';

// Single-key shortcuts for the live vote page. `bindings` maps a key (as in
// KeyboardEvent.key, lowercased for letters) to a handler. Ignored while typing,
// while a dialog is open, or with a modifier held, so they never fight the
// browser or a text field.

const isTyping = (target) =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));

export default function useLiveVoteShortcuts(bindings, { enabled = true } = {}) {
  const bindingsRef = useRef(bindings);
  bindingsRef.current = bindings;

  useEffect(() => {
    if (!enabled) return undefined;
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.repeat) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTyping(event.target)) return;
      if (document.querySelector('.MuiDialog-root')) return;

      const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
      const handler = bindingsRef.current[key];
      if (!handler) return;
      event.preventDefault();
      handler(event);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [enabled]);
}
