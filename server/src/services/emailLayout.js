import { convert } from 'html-to-text';
import {
  copyHtml,
  copyLine,
  copySignOff,
  escapeCopyHtml,
  styleCopyHtml,
} from './emailCopyRender.js';
import { fontStack, isHexColour, resolveEmailTheme } from './emailTheme.js';
import { resolveEmailStyle } from './emailTemplateStyle.js';
import { resolveSignature } from './emailSignatures.js';
import { currentEmailDraft } from './emailDrafts.js';

/**
 * Every automatic email, drawn by one renderer.
 *
 * A builder no longer writes HTML. It says what the email contains - a heading,
 * some copy, a card of details, a button, a sign-off - and this file decides
 * how that looks. That is what lets an admin restyle every email from one
 * theme, switch any one of them to Plain, and have a text version generated
 * for each, without touching forty builders.
 *
 * Two looks:
 *   - DESIGNED: header with the brand or logo, content, footer. Table-based,
 *     because Outlook ignores most of CSS layout, with every style inline,
 *     because most clients drop <style> blocks.
 *   - PLAIN: no header, cards or footer - reads like a message a person typed.
 *     The same content, so nothing the reader needs is lost: a card becomes a
 *     block of "Label: value" lines and a button becomes a link.
 *
 * What stays out of an admin's reach: the parts themselves. Cards are built
 * from data and buttons point where the code says, so a style change can alter
 * how an email looks and never what it tells somebody or where it sends them.
 */

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/**
 * What a builder hands the renderer. `text` fields are copy (merge fields
 * filled and escaped here, Markdown where copyHtml allows it). `rows[].value`
 * is plain text and escaped here; `lines` and `html` are already-escaped HTML
 * the builder composed from data.
 */
export const part = {
  heading: (text) => ({ kind: 'heading', text }),
  greeting: (text) => ({ kind: 'greeting', text }),
  copy: (text) => ({ kind: 'copy', text }),
  /** Trusted, already-rendered Markdown (the decision letters). */
  html: (html) => ({ kind: 'html', html }),
  card: ({ tone = 'neutral', title = null, titleText = null, rows = [], lines = [], copy = [] }) => ({
    kind: 'card',
    tone,
    title,
    titleText,
    rows: rows.filter(Boolean),
    lines: lines.filter(Boolean),
    copy: copy.filter(Boolean),
  }),
  button: (href, label) => ({ kind: 'button', href, label }),
  /** The raw URL under a button, for clients that strip buttons. */
  link: (href) => ({ kind: 'link', href }),
  signOff: (text) => ({ kind: 'signOff', text }),
  /** A saved signature, put in place of signOff by composeEmail. */
  signature: ({ body, imageUrl = null }) => ({ kind: 'signature', body, imageUrl }),
};

// A signature's Markdown with its optional image beneath. Merge fields are not
// offered in a signature, so none are filled.
function signatureHtml(p, { color, spacing, link }) {
  const text = copyHtml(p.body, {}, { color, spacing, link });
  const image = p.imageUrl
    ? `<p style="margin: 0 0 20px 0;"><img src="${attr(p.imageUrl)}" alt="" height="48" style="display: block; max-height: 48px; border: 0;" /></p>`
    : '';
  return text + image;
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------

// The card colours these emails already used, one scheme per tone.
const CARD_TONES = {
  neutral: { background: '#f8f9fa', border: null, title: '#333333', text: '#666666' },
  info: { background: '#cce7ff', border: '#007bff', title: '#004085', text: '#004085' },
  success: { background: '#d4edda', border: '#28a745', title: '#155724', text: '#155724' },
  danger: { background: '#f8d7da', border: '#dc3545', title: '#721c24', text: '#721c24' },
  muted: { background: '#f8f9fa', border: null, title: '#6c757d', text: '#6c757d' },
};

// Status headers. 'brand' is whatever the theme says.
const BANNER_COLOURS = {
  success: '#28a745',
  danger: '#dc3545',
  warning: '#fd7e14',
  info: '#0C74C1',
};

/** Dark text on a light background, white on a dark one. */
function readableOn(hex) {
  let value = hex.replace('#', '');
  if (value.length === 3) value = value.split('').map((c) => c + c).join('');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(value.slice(i, i + 2), 16) / 255);
  const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const luminance = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return luminance > 0.45 ? '#042742' : '#ffffff';
}

function bannerColours(banner, theme) {
  if (!banner || banner === 'brand') {
    return { background: theme.headerBackground, text: theme.headerTextColor };
  }
  const background = BANNER_COLOURS[banner] ?? (isHexColour(banner) ? banner : null);
  if (!background) return { background: theme.headerBackground, text: theme.headerTextColor };
  return { background, text: readableOn(background) };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const attr = (value) => escapeCopyHtml(value);

function designedPart(p, values, theme) {
  const link = theme.accentColor;
  switch (p.kind) {
    case 'heading': {
      const text = copyLine(p.text, values);
      return text ? `<h3 style="color: #333333; margin: 0 0 20px 0; font-size: 20px;">${text}</h3>` : '';
    }
    case 'greeting': {
      const text = copyLine(p.text, values);
      return text ? `<p style="color: #666666; line-height: 1.6; margin: 0 0 20px 0;">${text}</p>` : '';
    }
    case 'copy':
      return copyHtml(p.text, values, { link });
    case 'html':
      return styleCopyHtml(p.html, { link });
    case 'card': {
      const tone = CARD_TONES[p.tone] ?? CARD_TONES.neutral;
      const title = p.titleText != null ? copyLine(p.titleText, values) : p.title ? escapeCopyHtml(p.title) : '';
      const line = (html) => `<p style="color: ${tone.text}; margin: 8px 0;">${html}</p>`;
      const body = [
        title ? `<h4 style="color: ${tone.title}; margin: 0 0 12px 0; font-size: 16px;">${title}</h4>` : '',
        ...p.rows.map((row) => line(`<strong>${escapeCopyHtml(row.label)}:</strong> ${row.html ?? escapeCopyHtml(row.value)}`)),
        ...p.lines.map(line),
        ...p.copy.map((text) => copyHtml(text, values, { color: tone.text, spacing: 'tight', link })),
      ].join('');
      if (!body) return '';
      const border = tone.border ? ` border-left: 4px solid ${tone.border};` : '';
      return `<div style="background-color: ${tone.background}; padding: 20px; border-radius: 8px; margin: 20px 0;${border}">${body}</div>`;
    }
    case 'button':
      if (!p.href) return '';
      return `<p style="text-align: center; margin: 30px 0;"><a href="${attr(p.href)}" style="background-color: ${link}; color: #ffffff; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block; font-weight: bold;">${escapeCopyHtml(p.label)}</a></p>`;
    case 'link':
      if (!p.href) return '';
      return `<p style="color: ${link}; word-break: break-all; margin: 0 0 20px 0;"><a href="${attr(p.href)}" style="color: ${link}; text-decoration: underline;">${escapeCopyHtml(p.href)}</a></p>`;
    case 'signOff':
      return copySignOff(p.text, values);
    case 'signature':
      return signatureHtml(p, { color: '#666666', spacing: 'loose', link });
    default:
      return '';
  }
}

const PLAIN_TEXT = '#222222';
const PLAIN_P = 'line-height: 1.6; margin: 0 0 16px 0;';

function plainPart(p, values, theme) {
  const link = theme.accentColor;
  switch (p.kind) {
    case 'heading': {
      const text = copyLine(p.text, values);
      return text ? `<p style="color: ${PLAIN_TEXT}; ${PLAIN_P}"><strong>${text}</strong></p>` : '';
    }
    case 'greeting': {
      const text = copyLine(p.text, values);
      return text ? `<p style="color: ${PLAIN_TEXT}; ${PLAIN_P}">${text}</p>` : '';
    }
    case 'copy':
      return copyHtml(p.text, values, { color: PLAIN_TEXT, spacing: 'plain', link });
    case 'html':
      return styleCopyHtml(p.html, { color: PLAIN_TEXT, spacing: 'plain', link });
    case 'card': {
      const title = p.titleText != null ? copyLine(p.titleText, values) : p.title ? escapeCopyHtml(p.title) : '';
      const lines = [
        title ? `<strong>${title}</strong>` : '',
        ...p.rows.map((row) => `${escapeCopyHtml(row.label)}: ${row.html ?? escapeCopyHtml(row.value)}`),
        ...p.lines,
      ].filter(Boolean);
      const block = lines.length ? `<p style="color: ${PLAIN_TEXT}; ${PLAIN_P}">${lines.join('<br>')}</p>` : '';
      const copy = p.copy.map((text) => copyHtml(text, values, { color: PLAIN_TEXT, spacing: 'plain', link })).join('');
      return block + copy;
    }
    case 'button':
      if (!p.href) return '';
      return `<p style="color: ${PLAIN_TEXT}; ${PLAIN_P}"><a href="${attr(p.href)}" style="color: ${link};">${escapeCopyHtml(p.label)}</a></p>`;
    case 'link':
      // In a Plain email the button above is already a link; the raw URL is
      // only there for clients that drop buttons, which Plain has none of.
      return '';
    case 'signOff':
      return copySignOff(p.text, values, { color: PLAIN_TEXT });
    case 'signature':
      return signatureHtml(p, { color: PLAIN_TEXT, spacing: 'plain', link });
    default:
      return '';
  }
}

const HEAD = (title) => `<head>
  <meta http-equiv="Content-Type" content="text/html; charset=UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeCopyHtml(title)}</title>
</head>`;

/**
 * Pure: parts in, a complete HTML document out.
 *
 * `brand` is the name the email has always shown in its header. A theme
 * brand name, or a logo, replaces it everywhere.
 */
export function renderEmailLayout({ parts, values = {}, theme, style, brand = 'UConsulting ATS', title = '' }) {
  const font = fontStack(theme.fontFamily);

  if (style.format === 'PLAIN') {
    const body = parts.map((p) => plainPart(p, values, theme)).join('\n');
    return `<!DOCTYPE html>
<html>
${HEAD(title)}
<body style="margin: 0; padding: 16px; background-color: #ffffff;">
  <div style="font-family: ${font}; font-size: 14px; color: ${PLAIN_TEXT}; max-width: 600px;">
${body}
  </div>
</body>
</html>`;
  }

  const banner = bannerColours(style.banner, theme);
  const name = theme.brandName || brand;
  const header = theme.logoUrl
    ? `<img src="${attr(theme.logoUrl)}" alt="${attr(name)}" height="48" style="display: block; margin: 0 auto; max-height: 48px; border: 0;" />`
    : `<h2 style="color: ${banner.text}; margin: 0; font-size: 24px; font-family: ${font};">${escapeCopyHtml(name)}</h2>`;
  const footer = theme.footerText
    ? `<tr>
            <td style="background-color: #f8f9fa; padding: 20px; text-align: center; color: #666666; font-size: 12px; font-family: ${font};">
              <p style="margin: 0;">${escapeCopyHtml(theme.footerText).replace(/\r?\n/g, '<br>')}</p>
            </td>
          </tr>`
    : '';
  const body = parts.map((p) => designedPart(p, values, theme)).join('\n');

  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html xmlns="http://www.w3.org/1999/xhtml">
${HEAD(title)}
<body style="margin: 0; padding: 0; background-color: #f4f4f4; font-family: ${font};">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background-color: #f4f4f4; padding: 20px 0;">
    <tr>
      <td align="center">
        <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="max-width: 600px; width: 100%; background-color: #ffffff; border-radius: 8px; overflow: hidden;">
          <tr>
            <td style="background-color: ${banner.background}; padding: 20px; text-align: center;">
              ${header}
            </td>
          </tr>
          <tr>
            <td style="padding: 30px 20px; font-family: ${font};">
${body}
            </td>
          </tr>
          ${footer}
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Plain-text alternative
// ---------------------------------------------------------------------------

/**
 * The text/plain part that goes beside every HTML email.
 *
 * Derived from the HTML rather than written separately, so it can never say
 * something the HTML does not. Links keep their address ("Reset Password
 * [https://...]"), because in a text client the address is the only way to
 * follow one.
 */
export function htmlToPlainText(html) {
  if (!html) return '';
  return convert(html, {
    wordwrap: 78,
    selectors: [
      { selector: 'a', options: { hideLinkHrefIfSameAsText: true } },
      { selector: 'img', format: 'skip' },
      { selector: 'h2', options: { uppercase: false } },
      { selector: 'h3', options: { uppercase: false } },
      { selector: 'h4', options: { uppercase: false } },
      { selector: 'title', format: 'skip' },
    ],
  }).trim();
}

// ---------------------------------------------------------------------------
// Composing with the stored theme and style
// ---------------------------------------------------------------------------


/**
 * What a builder calls: resolves the theme and this email's style, then
 * renders. `key` is the template's copy key, which is also its style key.
 */
export async function composeEmail(key, { subject, values = {}, parts, brand, style: ownStyle = null }) {
  const draft = currentEmailDraft();
  // Independent reads, so they go together: every email renders on a request.
  // `ownStyle` is for emails that keep their style on their own row (the
  // admin-written automatic emails) rather than in EmailTemplateStyle.
  const [theme, style] = await Promise.all([
    draft?.theme ?? resolveEmailTheme(),
    ownStyle ?? draft?.styles?.[key] ?? resolveEmailStyle(key),
  ]);

  // A signature replaces the email's own sign-off. An email with no sign-off
  // part (the decision letters) is left as it is.
  const hasSignOff = parts.some((p) => p?.kind === 'signOff');
  const signature = hasSignOff ? await resolveSignature(style.signatureId) : null;
  const finalParts = signature ? parts.map((p) => (p?.kind === 'signOff' ? part.signature(signature) : p)) : parts;

  const html = renderEmailLayout({ parts: finalParts, values, theme, style, brand, title: subject });
  return { subject, html, format: style.format };
}

/**
 * A notice at the top of a test send, so whoever receives it cannot mistake
 * it for the real thing. Inside <body> rather than before the document: in
 * front of a doctype it is invalid markup some clients drop.
 */
export function withTestBanner(html, message) {
  const banner =
    '<div style="background:#fff4e5;border:1px solid #ffb74d;border-radius:6px;padding:12px;margin:0 0 16px 0;font-family:sans-serif;font-size:13px;color:#663c00;">' +
    `<strong>Test email</strong> - ${escapeCopyHtml(message)}` +
    '</div>';
  return /<body[^>]*>/i.test(html) ? html.replace(/(<body[^>]*>)/i, `$1${banner}`) : banner + html;
}
