import crypto from 'node:crypto';
import prisma from '../prismaClient.js';
import { suppressEmail } from './emailSuppression.js';
import { isSuspectedBot, recordEmailEngagement } from './analytics/emailEngagement.js';

// What happens to an email after SES accepts it.
//
// sendEmail logs SENT the moment SES takes the message, which only means SES
// agreed to try. Whether it reached a mailbox is decided minutes later by the
// recipient's server, and SES reports that through a configuration set's event
// destination -> an SNS topic -> POST /api/webhooks/ses. This file verifies
// those SNS posts and folds each event into the communication_logs row it is
// about.

// SNS signs with a certificate it hosts on its own domain. Anything else in
// SigningCertURL or SubscribeURL is somebody trying to get us to trust their key,
// or to make this server fetch a URL of their choosing.
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;

export function isSnsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && SNS_HOST.test(url.hostname);
  } catch {
    return false;
  }
}

// The fields SNS signs, in the order it signs them. Subject is only present on
// some notifications and is left out of the string when absent.
const SIGNED_FIELDS = {
  Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
  SubscriptionConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
  UnsubscribeConfirmation: ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'],
};

export function stringToSign(message) {
  const fields = SIGNED_FIELDS[message.Type];
  if (!fields) return null;
  return fields
    .filter((key) => message[key] !== undefined && message[key] !== null)
    .map((key) => `${key}\n${message[key]}\n`)
    .join('');
}

// SNS rotates certificates rarely and every notification names one, so each is
// fetched once per process.
const certCache = new Map();

async function fetchCertificate(url) {
  if (!certCache.has(url)) {
    const pending = fetch(url).then((res) => {
      if (!res.ok) throw new Error(`certificate fetch failed: ${res.status}`);
      return res.text();
    });
    certCache.set(url, pending);
    // A failed fetch must not be cached, or one network blip rejects every
    // notification until the process restarts.
    pending.catch(() => certCache.delete(url));
  }
  return certCache.get(url);
}

/**
 * True when `message` really came from SNS. `fetchCert` is injectable so tests
 * can sign with a key of their own.
 */
export async function verifySnsMessage(message, { fetchCert = fetchCertificate } = {}) {
  if (!message || typeof message !== 'object') return false;
  if (!isSnsUrl(message.SigningCertURL) || !new URL(message.SigningCertURL).pathname.endsWith('.pem')) {
    return false;
  }
  const algorithm = { 1: 'RSA-SHA1', 2: 'RSA-SHA256' }[message.SignatureVersion];
  const signed = stringToSign(message);
  if (!algorithm || !signed || !message.Signature) return false;

  try {
    const pem = await fetchCert(message.SigningCertURL);
    return crypto.verify(algorithm, Buffer.from(signed, 'utf8'), pem, Buffer.from(message.Signature, 'base64'));
  } catch (error) {
    console.error('[sesEvents] could not verify SNS signature:', error.message);
    return false;
  }
}

// A row only moves forward. SNS does not promise order, so a Delivery that
// arrives after the Bounce for the same message must not paper over it, and a
// spam complaint - which can only follow a delivery - outranks everything.
// A click implies delivery, so it outranks DELIVERED; a bounce or a spam
// complaint is still the more important thing to see, so they outrank it.
const STATUS_RANK = { SENT: 0, DELAYED: 1, DELIVERED: 2, CLICKED: 3, BOUNCED: 4, FAILED: 4, COMPLAINED: 5 };

const statusesBelow = (status) =>
  Object.keys(STATUS_RANK).filter((s) => STATUS_RANK[s] < STATUS_RANK[status]);

const addressOf = (value) => {
  // Recipients can arrive as `"Name" <addr>`; the log stores the bare address.
  const match = /<([^>]+)>/.exec(value || '');
  return (match ? match[1] : value || '').trim();
};

/**
 * Turn one SES event into { status, detail, recipients, engagement? }, or null
 * for events the log has no use for (Send, Subscription...).
 *
 * Open and Click (configuration-set click and open tracking) also carry
 * `engagement`, written to email_engagement_events for Site Analytics. A click
 * moves the row to CLICKED; an open changes no status, because OPENED already
 * means something else in the log and pixel opens are unreliable anyway.
 *
 * Configuration-set destinations call the field `eventType`; the older
 * identity-level notifications call it `notificationType`. Both are accepted so
 * it does not matter which one gets wired up.
 */
export function interpretSesEvent(event) {
  const type = event?.eventType || event?.notificationType;
  const all = (event?.mail?.destination || []).map(addressOf);

  switch (type) {
    case 'Delivery':
      return {
        status: 'DELIVERED',
        detail: null,
        recipients: (event.delivery?.recipients || all).map(addressOf),
      };
    case 'Bounce': {
      const bounce = event.bounce || {};
      const recipients = (bounce.bouncedRecipients || []).map((r) => ({
        address: addressOf(r.emailAddress),
        // The recipient server's own words, e.g. "550 5.1.1 user unknown", are
        // what tells an admin whether to fix the address or just try again.
        detail: [`${bounce.bounceType || 'Unknown'} bounce (${bounce.bounceSubType || 'General'})`, r.diagnosticCode]
          .filter(Boolean)
          .join(': '),
      }));
      return { status: 'BOUNCED', recipients };
    }
    case 'Complaint': {
      const complaint = event.complaint || {};
      const kind = complaint.complaintFeedbackType ? ` (${complaint.complaintFeedbackType})` : '';
      return {
        status: 'COMPLAINED',
        detail: `Recipient marked this as spam${kind}`,
        recipients: (complaint.complainedRecipients || []).map((r) => addressOf(r.emailAddress)),
      };
    }
    case 'DeliveryDelay': {
      const delay = event.deliveryDelay || {};
      return {
        status: 'DELAYED',
        recipients: (delay.delayedRecipients || []).map((r) => ({
          address: addressOf(r.emailAddress),
          detail: [`Delayed (${delay.delayType || 'Unknown'})`, r.diagnosticCode].filter(Boolean).join(': '),
        })),
      };
    }
    case 'Reject':
      return {
        status: 'FAILED',
        detail: `Rejected by SES: ${event.reject?.reason || 'unknown reason'}`,
        recipients: all,
      };
    case 'Rendering Failure':
      return {
        status: 'FAILED',
        detail: `Rendering failure: ${event.failure?.errorMessage || 'unknown'}`,
        recipients: all,
      };
    // Neither names a recipient, so the destination list stands in. This app
    // sends one recipient per message, so that is the person who acted.
    case 'Click': {
      const click = event.click || {};
      return {
        status: 'CLICKED',
        detail: null,
        recipients: all,
        engagement: { kind: 'CLICK', link: click.link || null, userAgent: click.userAgent, ip: click.ipAddress, at: click.timestamp },
      };
    }
    case 'Open': {
      const open = event.open || {};
      return {
        status: null,
        detail: null,
        recipients: all,
        engagement: { kind: 'OPEN', link: null, userAgent: open.userAgent, ip: open.ipAddress, at: open.timestamp },
      };
    }
    default:
      return null;
  }
}

/**
 * Apply one SES event to the log. Returns how many rows changed, which is 0 for
 * mail sent before this existed, mail sent from outside the app, and events
 * that would move a row backwards - all of which are normal, not errors.
 */
export async function applySesEvent(event) {
  const outcome = interpretSesEvent(event);
  const sesId = event?.mail?.messageId;
  if (!outcome || !sesId) return 0;

  // nodemailer's SES transport stores the id as `<sesId@region.amazonses.com>`.
  const idPrefix = `<${sesId}@`;
  let updated = 0;

  // A mail scanner following every link is not the recipient clicking, so a
  // suspected-bot click is recorded as engagement but changes no status.
  const botClick =
    outcome.engagement?.kind === 'CLICK' &&
    isSuspectedBot({ userAgent: outcome.engagement.userAgent, at: outcome.engagement.at, sentAt: event.mail?.timestamp });
  const status = botClick ? null : outcome.status;

  for (const entry of status ? outcome.recipients : []) {
    const { address, detail } = typeof entry === 'string' ? { address: entry, detail: outcome.detail } : entry;
    if (!address) continue;
    // One conditional write rather than read-then-write: two events for the
    // same row arriving together cannot both pass a stale check.
    const { count } = await prisma.communicationLog.updateMany({
      where: {
        channel: 'email',
        providerMessageId: { startsWith: idPrefix },
        recipient: { equals: address, mode: 'insensitive' },
        status: { in: statusesBelow(outcome.status) },
      },
      data: {
        status: outcome.status,
        // An event without detail - a delivery - clears the field. The only
        // thing it can be replacing is a delay note, and the log dialog shows
        // any error as a red alert, which is wrong next to "Delivered".
        error: detail ? String(detail).slice(0, 2000) : null,
      },
    });
    updated += count;
  }

  if (outcome.engagement) await recordEmailEngagement({ event, outcome, sesId });
  await suppressFromSesEvent(event, outcome);
  return updated;
}

/**
 * A spam complaint, or a bounce SES calls permanent (the mailbox does not
 * exist), takes the address off Master Communications marketing sends. A soft
 * bounce - full mailbox, greylisting - does not: those are worth trying again.
 *
 * Runs whether or not a log row matched, since mail sent before the log existed
 * bounces too. Never throws: SNS retries a failed post, and a suppression
 * failure must not make it replay an event the log already applied.
 */
async function suppressFromSesEvent(event, outcome) {
  let reason = null;
  if (outcome.status === 'COMPLAINED') reason = 'COMPLAINED';
  else if (outcome.status === 'BOUNCED' && event.bounce?.bounceType === 'Permanent') reason = 'BOUNCED';
  if (!reason) return;

  for (const entry of outcome.recipients) {
    const { address, detail } = typeof entry === 'string' ? { address: entry, detail: outcome.detail } : entry;
    if (!address) continue;
    try {
      await suppressEmail({ email: address, reason, source: 'SES', detail });
    } catch (error) {
      console.error('[sesEvents] could not record suppression:', error.message);
    }
  }
}

export default { verifySnsMessage, interpretSesEvent, applySesEvent, isSnsUrl };
