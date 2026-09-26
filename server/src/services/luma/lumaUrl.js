// What an admin may paste into an event's "Luma event link".
//
// The link is not decoration: the sync routine resolves it with `lookup_entity`
// to get the evt-... id every page of guests is then checked against. A typo
// therefore does not fail here, it fails an hour later inside a scheduled agent
// nobody is watching, so it is worth refusing at the point it is pasted.
//
// Only the host is checked. Luma serves events from lu.ma and luma.com and
// event paths vary (a bare slug, a calendar prefix), so constraining the path
// would refuse links that work.

const LUMA_HOSTS = new Set(['lu.ma', 'luma.com']);

const hostIsLuma = (hostname) => {
  const host = hostname.toLowerCase().replace(/^www\./, '');
  return LUMA_HOSTS.has(host) || [...LUMA_HOSTS].some((luma) => host.endsWith(`.${luma}`));
};

/**
 * @param {unknown} value  what the admin typed
 * @returns {{url: string|null, error?: string}} url is null when the field was
 *   cleared, which is how an event stops being a Luma event.
 */
export function parseLumaUrl(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return { url: null };

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return { url: null, error: 'The Luma event link must be a full URL, like https://lu.ma/your-event' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { url: null, error: 'The Luma event link must be an http(s) URL' };
  }
  if (!hostIsLuma(parsed.hostname)) {
    return { url: null, error: 'That is not a Luma link — it should be on lu.ma or luma.com' };
  }
  return { url: text };
}

/**
 * True when a saved link and a submitted one point somewhere different.
 *
 * Compared as typed rather than normalized, so a cosmetic edit counts as a
 * change. That costs one re-resolve on the next sync; the other direction would
 * leave an event pointing at one Luma event while its recorded evt-... id
 * belongs to another.
 */
export const lumaUrlChanged = (before, after) => (before ?? null) !== (after ?? null);

export default parseLumaUrl;
