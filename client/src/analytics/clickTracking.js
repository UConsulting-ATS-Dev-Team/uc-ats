import { maskText } from './normalizePath';
import { track } from './tracker';

// One listener for every click in the app, so no component has to opt in.
//
// What counts is the nearest button, link or [data-track] element. Its label
// is, in order: a data-track attribute (use it to name a button whose text is
// a person's name or other data), aria-label, then the visible text. Labels
// are capped and addresses masked. Form fields are never recorded, and
// [data-no-track] opts an element and everything inside it out.

const TARGET = '[data-track], button, a, [role="button"], [role="menuitem"], [role="tab"]';
const SKIP = 'input, textarea, select, [contenteditable="true"], [data-no-track]';
export const LABEL_MAX = 60;

export function labelFor(element) {
  const explicit = element.getAttribute('data-track') || element.getAttribute('aria-label') || element.getAttribute('title');
  // innerText keeps the spaces layout puts between child elements, which
  // textContent drops ("3×" + "Error" -> "3×Error"). jsdom has only textContent.
  const text = explicit || element.innerText || element.textContent || '';
  return maskText(text, LABEL_MAX);
}

export function handleClick(event) {
  try {
    const origin = event.target;
    if (!(origin instanceof Element)) return;
    if (origin.closest(SKIP)) return;
    const element = origin.closest(TARGET);
    if (!element) return;
    const label = labelFor(element);
    if (!label) return;
    const meta = { tag: element.tagName.toLowerCase() };
    track('click', { name: label, meta });
  } catch {
    // never break a click
  }
}

let installed = false;

export function installClickTracking() {
  if (installed) return;
  installed = true;
  document.addEventListener('click', handleClick, true);
}
