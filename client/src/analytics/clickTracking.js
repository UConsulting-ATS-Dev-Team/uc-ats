import { maskText, normalizePath } from './normalizePath';
import { track } from './tracker';

// One listener for every click in the app, so no component has to opt in.
//
// This is a recruiting system: candidate names, vote status and decisions are
// on screen everywhere, often inside the very buttons people click (a roster
// chip's aria-label is "3. Jane Doe, Voted"). Masking cannot find a name, so
// the label is built from structure, and page text is used only when it looks
// like the app's own fixed copy:
//
//   1. data-track - an explicit, reviewed label. Use it for any button worth
//      counting whose text is data.
//   2. A link records where it goes (normalized), never its text.
//   3. Inside a table row, list item or option - where data lives - no text at
//      all, only what kind of thing was clicked.
//   4. Otherwise aria-label or visible text, only if it passes looksLikeUiCopy.
//
// Form fields are never recorded, and [data-no-track] opts an element and
// everything inside it out.

const TARGET = '[data-track], button, a, [role="button"], [role="menuitem"], [role="tab"]';
const SKIP = 'input, textarea, select, [contenteditable="true"], [data-no-track]';
const DATA_CONTAINER = 'td, th, tr, li, [role="row"], [role="gridcell"], [role="listitem"], [role="option"]';
export const LABEL_MAX = 60;

const UI_COPY_MAX_WORDS = 5;
const UI_COPY_MAX_LENGTH = 40;
// Two capitalized words in a row is how a name reads ("Jane Doe").
const NAME_LIKE = /\p{Lu}\p{Ll}+[\s,.'-]+\p{Lu}\p{Ll}+/u;

/**
 * True when text reads like a fixed button label ("Save changes", "Run rollup
 * now") rather than data. Conservative on purpose: a Title Case label is
 * dropped along with the names, and gets counted by adding data-track.
 */
export function looksLikeUiCopy(text) {
  if (!text) return false;
  if (text.length > UI_COPY_MAX_LENGTH) return false;
  if (text.split(/\s+/).length > UI_COPY_MAX_WORDS) return false;
  if (/[\d@]/.test(text)) return false;
  if (NAME_LIKE.test(text)) return false;
  return true;
}

const clean = (text) => maskText(text, LABEL_MAX);

function linkTarget(element) {
  const href = element.getAttribute('href');
  if (!href || href.startsWith('#') || href.startsWith('javascript:')) return null;
  try {
    const url = new URL(href, window.location.origin);
    if (url.origin !== window.location.origin) return `→ ${url.hostname}`;
    return `→ ${normalizePath(url.pathname)}`;
  } catch {
    return null;
  }
}

export function labelFor(element) {
  const explicit = element.getAttribute('data-track');
  if (explicit) return clean(explicit);

  const tag = element.tagName.toLowerCase();
  if (tag === 'a') {
    const target = linkTarget(element);
    if (target) return target;
  }

  const kind = element.getAttribute('role') || tag;
  if (element.closest(DATA_CONTAINER)) return `(${kind} in a list)`;

  // innerText keeps the spaces layout puts between child elements, which
  // textContent drops ("3×" + "Error" -> "3×Error"). jsdom has only textContent.
  for (const candidate of [element.getAttribute('aria-label'), element.innerText || element.textContent]) {
    // Judged before masking: "Email [email]" would otherwise pass as copy.
    const text = String(candidate || '').replace(/\s+/g, ' ').trim();
    if (looksLikeUiCopy(text)) return clean(text);
  }
  return `(${kind})`;
}

export function handleClick(event) {
  try {
    const origin = event.target;
    if (!(origin instanceof Element)) return;
    if (origin.closest(SKIP)) return;
    const element = origin.closest(TARGET);
    if (!element) return;
    track('click', { name: labelFor(element), meta: { tag: element.tagName.toLowerCase() } });
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
