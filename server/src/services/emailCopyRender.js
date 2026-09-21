import { marked } from 'marked';

/**
 * Turning admin-written copy into the HTML an email client will actually show.
 *
 * Two rules drive everything here:
 *
 *   - Merge field values are escaped, the surrounding copy is not. A value is
 *     somebody's name or an event title; the copy around it is Markdown an
 *     admin wrote on purpose, and escaping that would print the syntax. This is
 *     the same split decisionTemplates.js has always made.
 *   - Every style is inline. Mail clients drop <style> blocks and most of them
 *     ignore classes, so a <p> that arrives without a style attribute arrives
 *     looking nothing like the paragraph beside it. marked emits bare tags, so
 *     the styles are injected here rather than written into the copy.
 *
 * Nothing in this file reads the database. It is the "how", so that the store
 * and the templates can be about which words go where.
 */

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export const escapeCopyHtml = (value) =>
  String(value ?? '').replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);

/**
 * Replace `{{field}}` with its value.
 *
 * A placeholder with no value is left standing rather than blanked, so a typo
 * shows up as `{{candiateName}}` in the preview instead of disappearing into a
 * sentence with a hole in it. Saving a template validates its placeholders
 * against the declared merge fields, so this case should only ever be reachable
 * from a default, which is to say from a bug in this repo.
 *
 * `trusted: true` marks a value that is composed here rather than typed by a
 * person - a Markdown link built from a server URL - and must not be escaped or
 * the syntax prints instead of rendering.
 */
export function fillMergeFields(text, values = {}, { escape = true } = {}) {
  return String(text ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (token, key) => {
    if (!Object.prototype.hasOwnProperty.call(values, key)) return token;
    const entry = values[key];
    const { value, trusted = false } = (entry && typeof entry === 'object' && 'value' in entry)
      ? entry
      : { value: entry };
    if (value === null || value === undefined) return '';
    return escape && !trusted ? escapeCopyHtml(value) : String(value);
  });
}

/** Merge fields filled, nothing escaped, no line breaks. For subjects. */
export const copySubject = (text, values) =>
  fillMergeFields(text, values, { escape: false }).replace(/[\r\n]+/g, ' ').trim();

/**
 * Copy on its way into HTML: the sentence itself escaped, then its values
 * filled in (and escaped in turn).
 *
 * Escaping the sentence is what keeps the promise the editor makes. It says the
 * layout is not editable, and a `<div style="...">` typed into a body would
 * make that false - Markdown passes raw HTML straight through. Escaped first,
 * a typed tag arrives as the text somebody typed. Markdown still works, because
 * `**bold**` and `[text](url)` contain nothing that needs escaping.
 */
const escapedWithValues = (text, values) => fillMergeFields(escapeCopyHtml(text), values);

/** Merge fields filled and escaped, but not parsed as Markdown. For headings. */
export const copyLine = (text, values) =>
  escapedWithValues(text, values).replace(/[\r\n]+/g, ' ').trim();

// Where a link in an email may point. `javascript:` and `data:` are the reason
// this list exists; a relative link has no meaning in a mail client, so the
// list is absolute schemes plus the in-page anchors the previews use.
const SAFE_LINK = /^(https?:\/\/|mailto:|tel:|#)/i;

/**
 * Point anything else at nothing, rather than shipping it to a candidate.
 *
 * Applied to rendered HTML rather than to the Markdown that produced it, which
 * is the only place it can be complete. Markdown has several ways to write a
 * link - inline, reference-style, a bare autolink - and a check that knows
 * about one of them is a check with a hole in it. By here they are all `href`.
 */
export const defuseUnsafeLinks = (html) =>
  html.replace(/<a href="([^"]*)"/g, (match, href) =>
    SAFE_LINK.test(href.trim()) ? match : '<a href="#"'
  );

// The paragraph styles these emails have always used. `tight` is the spacing
// inside a coloured card, `loose` the spacing of body copy between cards.
const SPACING = {
  loose: 'line-height: 1.6; margin-bottom: 20px;',
  tight: 'line-height: 1.6; margin: 8px 0;',
  snug: 'line-height: 1.6; margin: 5px 0;',
};

/**
 * Render one copy field as styled HTML.
 *
 * `color` and `spacing` exist because the same helper draws body copy (grey,
 * generously spaced) and the lines inside a coloured card (the card's own text
 * colour, packed tight). Passing them per call is what lets the rendered output
 * keep matching the markup it replaced, card by card.
 */
export function copyHtml(text, values, { color = '#666', spacing = 'loose', link = '#007bff' } = {}) {
  const filled = escapedWithValues(text, values);
  if (!filled.trim()) return '';

  const paragraph = `color: ${color}; ${SPACING[spacing] ?? SPACING.loose}`;
  const html = defuseUnsafeLinks(marked.parse(filled, { breaks: true }));

  return html
    .replace(/<p>/g, `<p style="${paragraph}">`)
    .replace(/<ul>/g, `<ul style="color: ${color}; line-height: 1.6; margin: 0 0 20px 0; padding-left: 20px;">`)
    .replace(/<ol>/g, `<ol style="color: ${color}; line-height: 1.6; margin: 0 0 20px 0; padding-left: 20px;">`)
    .replace(/<li>/g, '<li style="margin: 0 0 8px 0;">')
    .replace(/<a href=/g, `<a style="color: ${link};" href=`)
    .trim();
}

/**
 * A sign-off, which is the one field where the line break is the point.
 *
 * "Best regards," and the team name are two lines of one paragraph, so this
 * escapes and joins with <br> rather than letting Markdown open a second <p>.
 */
export function copySignOff(text, values, { color = '#666' } = {}) {
  const filled = escapedWithValues(text, values);
  if (!filled.trim()) return '';
  const lines = filled.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return `<p style="color: ${color}; ${SPACING.loose}">${lines.join('<br>')}</p>`;
}

/** Every `{{field}}` a piece of copy refers to, in the order it first appears. */
export function mergeFieldsUsed(text) {
  const found = [];
  for (const [, key] of String(text ?? '').matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
    if (!found.includes(key)) found.push(key);
  }
  return found;
}
