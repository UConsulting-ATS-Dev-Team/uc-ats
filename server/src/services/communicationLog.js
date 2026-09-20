import prisma from '../prismaClient.js';

// The kinds of message the system produces. Kept as plain strings rather than a
// Prisma enum so adding an email never costs a migration; this list exists so
// the admin filter has something to offer and so spellings stay consistent.
export const COMMUNICATION_CATEGORIES = [
  'ACCOUNT',              // verification, password reset and its confirmation
  'APPLICATION_DECISION', // accept / reject at any round
  'OFFER_LETTER',
  'EVENT',                // RSVP and attendance confirmations
  'MEETING',              // coffee chat signup, cancellation, reschedule
  'INTERVIEW_SLOT',       // slot invitations, reminders, changes
  'REVIEWER_REMINDER',
  'MASTER_COMMUNICATION', // composed by hand in Master Communications
  'DECISION_BATCH',       // queued by Process All Decisions, sent by an admin
  'TEST',                 // "send this to me first"
  'OTHER',
];

export const COMMUNICATION_CHANNELS = ['email', 'slack', 'imessage'];

// SENT and FAILED mean what they say. OPENED is only ever an iMessage: the
// server hands the conversation to the admin's Messages app and cannot observe
// what happens next, so claiming it was sent would be a lie.
export const COMMUNICATION_STATUSES = ['SENT', 'FAILED', 'OPENED'];

const BODY_PREVIEW_LIMIT = 2000;

// Query parameters that carry a live credential. Password resets, email
// verification and the set-your-password link in a decision email all render
// their URL as visible text, so without this the log would hand any admin a
// working reset token for somebody else's account for as long as it lasts.
const SECRET_PARAMS = /^(token|resettoken|invite|inviteToken|code|key|secret|auth|access_token|refresh_token|signature|sig)$/i;

/**
 * Strip the value out of any token-bearing query parameter, keeping enough of
 * the URL to recognise which email this was.
 *
 * Runs on the text after tags are removed, so it catches the address whether it
 * appeared as a href or as visible anchor text.
 */
export function redactSecrets(text) {
  if (!text) return text;
  return text.replace(/([?&])([A-Za-z0-9_-]+)=([^\s&"'<>]+)/g, (match, sep, name, value) =>
    SECRET_PARAMS.test(name) ? `${sep}${name}=[redacted]` : match
  );
}

/**
 * Reduce an HTML body to the text a person would read, capped. The log is for
 * identifying a message, not for reproducing it, and full decision letters
 * stored twice add up fast.
 */
export function toBodyPreview(body) {
  if (!body) return null;
  const text = String(body)
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    // A paragraph break reads as a blank line; a row or list item as one break.
    // Runs of either collapse below, so nested divs cost nothing.
    .replace(/<\/(p|div)>/gi, '\n\n')
    .replace(/<\/(tr|li|h[1-6])>/gi, '\n')
    // Every other tag becomes a space, or `Hi <strong>Ryan</strong>` would read
    // as `HiRyan`.
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    // The spaces those tags left sit either side of the breaks they left too.
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!text) return null;
  const safe = redactSecrets(text);
  return safe.length > BODY_PREVIEW_LIMIT ? `${safe.slice(0, BODY_PREVIEW_LIMIT)}…` : safe;
}

/**
 * Record one outbound message to one recipient.
 *
 * Best-effort on purpose. A send that actually happened must not be turned into
 * a failure because the audit row would not write, so every error is swallowed
 * and logged. Callers do not await anything that matters.
 */
export async function recordCommunication({
  channel = 'email',
  category = 'OTHER',
  trigger = 'AUTOMATED',
  status = 'SENT',
  recipient,
  recipientName = null,
  subject = null,
  body = null,
  bodyPreview = null,
  error = null,
  providerMessageId = null,
  hasAttachments = false,
  triggeredById = null,
  messageLogId = null,
  cycleId = null,
  attemptKey = null,
  sentAt = undefined,
} = {}) {
  if (!recipient) return null;
  const data = {
    channel,
    category,
    trigger,
    status,
    recipient: String(recipient).slice(0, 512),
    recipientName,
    subject: subject ? redactSecrets(String(subject)).slice(0, 998) : null,
    bodyPreview: bodyPreview ? redactSecrets(String(bodyPreview)) : toBodyPreview(body),
    error: error ? String(error).slice(0, 2000) : null,
    providerMessageId,
    hasAttachments,
    triggeredById,
    messageLogId,
    cycleId,
    attemptKey,
    ...(sentAt ? { sentAt } : {}),
  };

  try {
    // With a key, the second and third attempts at the same message overwrite
    // the first rather than piling up beside it: the log keeps one row per
    // recipient per message, showing how it ended rather than how it went.
    const row = attemptKey
      ? await prisma.communicationLog.upsert({
          where: { attemptKey },
          create: data,
          update: { ...data, sentAt: sentAt ?? new Date() },
          select: { id: true },
        })
      : await prisma.communicationLog.create({ data, select: { id: true } });
    return row.id;
  } catch (e) {
    console.error('[communicationLog] failed to record communication:', e);
    return null;
  }
}

/** Record one message that went to many people, without N round trips. */
export async function recordCommunications(entries = []) {
  const rows = entries.filter((e) => e && e.recipient);
  if (rows.length === 0) return 0;
  try {
    const result = await prisma.communicationLog.createMany({
      data: rows.map((e) => ({
        channel: e.channel || 'email',
        category: e.category || 'OTHER',
        trigger: e.trigger || 'AUTOMATED',
        status: e.status || 'SENT',
        recipient: String(e.recipient).slice(0, 512),
        recipientName: e.recipientName ?? null,
        subject: e.subject ? redactSecrets(String(e.subject)).slice(0, 998) : null,
        bodyPreview: e.bodyPreview ? redactSecrets(String(e.bodyPreview)) : toBodyPreview(e.body),
        error: e.error ? String(e.error).slice(0, 2000) : null,
        providerMessageId: e.providerMessageId ?? null,
        hasAttachments: e.hasAttachments ?? false,
        triggeredById: e.triggeredById ?? null,
        messageLogId: e.messageLogId ?? null,
        cycleId: e.cycleId ?? null,
        ...(e.sentAt ? { sentAt: e.sentAt } : {}),
      })),
    });
    return result.count;
  } catch (e) {
    console.error('[communicationLog] failed to record communications:', e);
    return 0;
  }
}

const LIST_SELECT = {
  id: true,
  channel: true,
  category: true,
  trigger: true,
  status: true,
  recipient: true,
  recipientName: true,
  subject: true,
  bodyPreview: true,
  error: true,
  hasAttachments: true,
  messageLogId: true,
  sentAt: true,
  triggeredBy: { select: { id: true, fullName: true, email: true } },
  cycle: { select: { id: true, name: true } },
};

const MAX_PAGE = 200;

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * The upper bound of a date range, as an exclusive `lt`.
 *
 * The date picker sends `YYYY-MM-DD`, which parses to midnight at the *start* of
 * that day. Used as `lte` it would drop everything sent during the day the admin
 * picked, so a date-only value advances to the start of the next day instead. A
 * full timestamp is taken at its word.
 */
function parseRangeEnd(value) {
  const d = parseDate(value);
  if (!d) return null;
  if (!DATE_ONLY.test(String(value).trim())) return d;
  return new Date(d.getTime() + 24 * 60 * 60 * 1000);
}

/**
 * The admin-facing read. Every filter is optional; with none of them this is
 * "everything that has ever gone out, newest first".
 *
 * Paged by offset rather than cursor: an admin scanning a log jumps around, and
 * the page sizes here are small enough that the offset cost never shows.
 */
export async function listCommunications({
  cycleId,
  channel,
  category,
  status,
  trigger,
  search,
  from,
  to,
  limit = 50,
  offset = 0,
} = {}) {
  const take = Math.min(Math.max(parseInt(limit, 10) || 50, 1), MAX_PAGE);
  const skip = Math.max(parseInt(offset, 10) || 0, 0);

  const where = {};
  if (cycleId) where.cycleId = cycleId;
  if (channel) where.channel = channel;
  if (category) where.category = category;
  if (status) where.status = status;
  if (trigger) where.trigger = trigger;

  const fromDate = parseDate(from);
  const toDate = parseRangeEnd(to);
  if (fromDate || toDate) {
    where.sentAt = {};
    if (fromDate) where.sentAt.gte = fromDate;
    if (toDate) where.sentAt.lt = toDate;
  }

  const term = typeof search === 'string' ? search.trim() : '';
  if (term) {
    where.OR = [
      { recipient: { contains: term, mode: 'insensitive' } },
      { recipientName: { contains: term, mode: 'insensitive' } },
      { subject: { contains: term, mode: 'insensitive' } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.communicationLog.findMany({
      where,
      orderBy: { sentAt: 'desc' },
      take,
      skip,
      select: LIST_SELECT,
    }),
    prisma.communicationLog.count({ where }),
  ]);

  return { rows, total, limit: take, offset: skip };
}

/** What the filter dropdowns offer, narrowed to values actually present. */
export async function listCommunicationFacets({ cycleId } = {}) {
  const where = cycleId ? { cycleId } : {};
  try {
    const [channels, categories, statuses] = await Promise.all([
      prisma.communicationLog.groupBy({ by: ['channel'], where, _count: { _all: true } }),
      prisma.communicationLog.groupBy({ by: ['category'], where, _count: { _all: true } }),
      prisma.communicationLog.groupBy({ by: ['status'], where, _count: { _all: true } }),
    ]);
    return {
      channels: channels.map((c) => ({ value: c.channel, count: c._count._all })),
      categories: categories.map((c) => ({ value: c.category, count: c._count._all })),
      statuses: statuses.map((s) => ({ value: s.status, count: s._count._all })),
    };
  } catch (e) {
    console.error('[communicationLog] failed to load facets:', e);
    return { channels: [], categories: [], statuses: [] };
  }
}

export default {
  COMMUNICATION_CATEGORIES,
  COMMUNICATION_CHANNELS,
  COMMUNICATION_STATUSES,
  toBodyPreview,
  recordCommunication,
  recordCommunications,
  listCommunications,
  listCommunicationFacets,
};
