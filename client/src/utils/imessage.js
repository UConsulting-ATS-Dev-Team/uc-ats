// iMessage from Master Communications leaves through the admin's own Messages
// app: the page opens an sms:// link and Messages takes it from there. So the
// message has to be plain text by the time it is in the link.

/**
 * Turns the composer's Markdown-lite into what Messages will show. Messages
 * renders no Markdown, so formatting marks are dropped rather than left as
 * literal asterisks, and links become bare URLs Messages can preview.
 */
export function toImessageText(markdown) {
  if (!markdown) return '';
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/\[([^\]]*)\]\(([^)\s]+)\)/g, (_, text, url) => {
      const label = text.trim();
      return !label || label === url || label === 'text' ? url : `${label}: ${url}`;
    })
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1$2')
    .replace(/^(\s*)[-*]\s+/gm, '$1• ')
    .trim();
}

/**
 * A link that opens one new Messages conversation with every number in it (a
 * group chat when there are several) and the text already typed.
 *
 * The `sms://open?addresses=` form is the one macOS and iOS both accept for
 * multiple recipients; the plain `sms:+1…&body=` form only takes one.
 */
export function buildImessageUrl(phoneNumbers, text) {
  const addresses = [...new Set(phoneNumbers.filter(Boolean))].join(',');
  const query = `addresses=${addresses}`;
  return text
    ? `sms://open?${query}&body=${encodeURIComponent(text)}`
    : `sms://open?${query}`;
}
