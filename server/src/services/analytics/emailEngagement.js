import crypto from 'node:crypto';

import prisma from '../../prismaClient.js';
import { logError } from './log.js';

// SES open and click events -> email_engagement_events, for the Email tab.
// Called from applySesEvent (services/sesEvents.js).
//
// Security products fetch every link in a message the moment it arrives, so a
// click is not a person until shown otherwise. isSuspectedBot marks the ones
// that look automated; the Email tab counts them apart rather than dropping
// them, so the numbers still reconcile with what SES reports.

// A person does not read and click within three seconds of delivery.
const HUMAN_MIN_DELAY_MS = 3000;
const SCANNER_UA =
  /bot|crawl|spider|scan|preview|proofpoint|mimecast|barracuda|urldefense|safelinks|messagelabs|fireeye|python-requests|curl|wget|go-http-client|okhttp|headless/i;

export function isSuspectedBot({ userAgent, at, sentAt }) {
  if (!userAgent || !/mozilla/i.test(userAgent)) return true;
  if (SCANNER_UA.test(userAgent)) return true;
  const acted = Date.parse(at);
  const sent = Date.parse(sentAt);
  if (Number.isFinite(acted) && Number.isFinite(sent) && acted - sent < HUMAN_MIN_DELAY_MS) return true;
  return false;
}

/** The clicked URL without its query or fragment, which is where tokens and tracking ids live. */
export function stripQuery(link) {
  if (!link) return null;
  try {
    const url = new URL(link);
    return `${url.origin}${url.pathname}`.slice(0, 500);
  } catch {
    return String(link).split(/[?#]/)[0].slice(0, 500);
  }
}

// SNS delivers at least once. The same notification twice must count once, so
// the row id is derived from what makes the event itself unique.
const eventId = (parts) => {
  const hex = crypto.createHash('sha1').update(parts.join('|')).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

// How far back an engagement row without a log id is worth re-matching. SES
// reports within minutes; anything older is from mail sent outside the app
// and will never match.
const ORPHAN_LOOKBACK_MS = 14 * 24 * 60 * 60 * 1000;

/**
 * Attach clicks and opens that arrived before their communications log row
 * was written (or while that write was failing) to the row, now that it
 * exists. Idempotent and bounded to recent unlinked rows. Called before the
 * Email tab reads and by the nightly rollup. Never throws.
 */
export async function linkOrphanEngagement(client = prisma, now = new Date()) {
  try {
    const since = new Date(now.getTime() - ORPHAN_LOOKBACK_MS).toISOString();
    return await client.$executeRaw`
      UPDATE email_engagement_events e
      SET "communicationLogId" = l.id,
          category = coalesce(e.category, l.category)
      FROM communication_logs l
      WHERE e."communicationLogId" IS NULL
        AND e.at >= ${since}::timestamp
        AND l.channel = 'email'
        AND l."providerMessageId" LIKE '<' || e."sesMessageId" || '@%'
        AND lower(l.recipient) = e.recipient`;
  } catch (error) {
    logError('[analytics] could not link email engagement to log rows:', error?.message || error);
    return 0;
  }
}

/** Never throws: SNS retries a failed post, and this must not make it replay an event the log already applied. */
export async function recordEmailEngagement({ event, outcome, sesId }, client = prisma) {
  try {
    const { kind, link, userAgent = null, ip = null, at } = outcome.engagement;
    const when = at && Number.isFinite(Date.parse(at)) ? new Date(at) : new Date();
    const taggedCategory = event?.mail?.tags?.category?.[0] || null;
    const cleanLink = stripQuery(link);
    const suspectedBot = isSuspectedBot({ userAgent, at: when.toISOString(), sentAt: event?.mail?.timestamp });

    const rows = [];
    for (const entry of outcome.recipients) {
      const recipient = typeof entry === 'string' ? entry : entry?.address;
      if (!recipient) continue;
      const logRow = await client.communicationLog.findFirst({
        where: { channel: 'email', providerMessageId: { startsWith: `<${sesId}@` }, recipient: { equals: recipient, mode: 'insensitive' } },
        select: { id: true, category: true },
      });
      rows.push({
        id: eventId([sesId, kind, recipient.toLowerCase(), when.toISOString(), link || '']),
        at: when,
        kind,
        communicationLogId: logRow?.id ?? null,
        sesMessageId: sesId,
        recipient: recipient.toLowerCase(),
        category: logRow?.category ?? taggedCategory,
        link: cleanLink,
        userAgent: userAgent ? String(userAgent).slice(0, 300) : null,
        ip,
        suspectedBot,
      });
    }
    if (rows.length) await client.emailEngagementEvent.createMany({ data: rows, skipDuplicates: true });
    return rows.length;
  } catch (error) {
    logError('[analytics] could not record an email engagement event:', error?.message || error);
    return 0;
  }
}
