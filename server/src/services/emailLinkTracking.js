import { redactSecrets } from './communicationLog.js';

// SES click tracking (enabled on the configuration set, see CLAUDE.md) rewrites
// every link in a message to go through awstrack.me first. That is fine for a
// "View your interview" button and wrong for a link that is itself a
// credential: a password reset, an email verification, a set-your-password
// invite or an unsubscribe token would all pass through a third-party redirect
// and sit in its logs. SES skips any <a> carrying the ses:no-track attribute.
//
// sendEmail runs every outgoing message through markUntrackedLinks, so no
// template has to remember. What counts as a credential is the same rule the
// communications log redacts on (SECRET_PARAMS in communicationLog.js), plus
// unsubscribe links, whose token is the `t` parameter.

const UNSUBSCRIBE = /\/unsubscribe(\/|\?|$)/i;
const ANCHOR = /<a\b([^>]*)>/gi;
const HREF = /\bhref\s*=\s*("([^"]*)"|'([^']*)')/i;

const decodeEntities = (s) => s.replace(/&amp;/gi, '&').replace(/&#38;/g, '&');

export function carriesCredential(href) {
  if (!href) return false;
  const url = decodeEntities(href);
  return redactSecrets(url) !== url || UNSUBSCRIBE.test(url);
}

/** Never throws: marking links must not be the reason an email fails to send. */
export function markUntrackedLinks(html) {
  if (typeof html !== 'string' || !html.includes('<a')) return html;
  try {
    return html.replace(ANCHOR, (tag, attrs) => {
      if (/\bses:no-track\b/i.test(attrs)) return tag;
      const match = HREF.exec(attrs);
      const href = match ? match[2] ?? match[3] : null;
      return carriesCredential(href) ? `<a ses:no-track${attrs}>` : tag;
    });
  } catch {
    return html;
  }
}

/** An SES message tag value: [A-Za-z0-9_-], at most 256 characters, never empty. */
export function sesTagValue(value) {
  const cleaned = String(value || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 256);
  return cleaned || 'OTHER';
}
