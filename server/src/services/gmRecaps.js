import prisma from '../prismaClient.js';
import { sendEmail } from './emailNotifications.js';
import { resolveEmailTheme } from './emailTheme.js';
import {
  markdownToHtml,
  previewMasterCommunication,
  renderMessage,
  sendMasterCommunication,
} from './masterCommunications.js';

// Weekly general meeting recaps, written by the executive committee behind
// executive access and sent to every active member and admin.
//
// The send itself is Master Communications' bulk email (one campaign row in
// message_logs, one communication_logs row per person); this file owns the
// recap's look, its lifecycle and when it goes.
//
// Lifecycle (RECAP_STATUS):
//   DRAFT     - editable, deletable.
//   SCHEDULED - waiting for scheduledAt; still editable, or back to DRAFT.
//               "Send now" is a schedule for now.
//   SENDING   - claimed by one server, which is mailing it.
//   SENT      - done; sentCount / failedCount say how it went.
//   FAILED    - nobody got it, or an exec settled an interrupted send.
//
// Sending is claimed (SCHEDULED -> SENDING, conditional) before any email goes
// out, by the cron every minute or straight after "Send now". Every server runs
// the cron, and only the claimer sends. A server that dies mid-send leaves the
// recap SENDING and nothing resends it: part of the list already has it. Its
// heartbeat stops, the page shows it as interrupted, and the campaign log says
// exactly who got it - the scheduled-message rule in masterCommunications.js.

export const RECAP_STATUS = Object.freeze({
  DRAFT: 'DRAFT',
  SCHEDULED: 'SCHEDULED',
  SENDING: 'SENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
});

export const RECAP_SENDER = Object.freeze({
  fromName: 'UConsulting Executive Team',
  replyTo: 'uconsultingla@gmail.com',
});

// Every active member and admin: the people at general meeting.
const AUDIENCE = Object.freeze({ audience: 'members', filters: { roles: ['MEMBER', 'ADMIN'] } });

export const FOOTER_ADDRESS = 'UConsulting · 330 De Neve Dr · Los Angeles, CA 90024-8301 · USA';
const SERIF = "Georgia, 'Times New Roman', Times, serif";

const LIMITS = { subject: 200, title: 120, body: 50000, url: 1000 };
const HEARTBEAT_MS = 60 * 1000;
export const STUCK_SENDING_MS = 15 * 60 * 1000;
const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;
// A schedule this far in the past is a mistake (a stale tab), not "now".
const PAST_GRACE_MS = 5 * 60 * 1000;

const fail = (status, message, code) => Object.assign(new Error(message), { status, code });

// ---------------------------------------------------------------------------
// Template
// ---------------------------------------------------------------------------

const SEASONS = [
  { name: 'Winter', months: [0, 1, 2] },
  { name: 'Spring', months: [3, 4, 5] },
  { name: 'Summer', months: [6, 7] },
  { name: 'Fall', months: [8, 9, 10, 11] },
];

export const seasonOf = (date) => SEASONS.find((s) => s.months.includes(date.getMonth())).name;

/**
 * The next week's title: one past the latest recap of the same season, or
 * week 1. "RECAP: FALL WEEK 3" is read back loosely, so a hand-edited title
 * still counts.
 */
export function nextRecapWeek(previousTitles, now = new Date()) {
  const season = seasonOf(now);
  const pattern = new RegExp(`${season}\\s+week\\s+(\\d+)`, 'i');
  const weeks = previousTitles.map((t) => Number(pattern.exec(t || '')?.[1])).filter(Number.isFinite);
  return { season, week: weeks.length ? Math.max(...weeks) + 1 : 1 };
}

export const TEMPLATE_BODY = `Hope you all had a great week! Here are some important updates:

**Updates & Action Items**

1. **Event name, day @ time:** What it is and whether it is mandatory. Link to register.
2. **Social, day @ time at place:** One line on why people should come.

**Committee Updates**

1. **Student Events:** What they ran or are planning.
2. **Marketing:** Anything members need to do, with the link.

**Project Updates**

1. **Midpoints:** Reminder of what teams should be doing and by when.

As always, let us know if there's anything we could be doing better and thank you for all the effort you put into our UC Fam!

See you soon,

Exec`;

export function templateFor({ season, week }) {
  return {
    subject: `GM Recap: ${season} Week ${week}`,
    title: `RECAP: ${season.toUpperCase()} WEEK ${week}`,
    body: TEMPLATE_BODY,
  };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const escapeHtml = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const isHttpsUrl = (value) => {
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
};

const BODY_STYLES = [
  // Clients drop <style>, so the Markdown's tags get their look inline.
  [/<p>/g, `<p style="margin: 0 0 16px; font-family: ${SERIF}; font-size: 16px; line-height: 1.5; color: #222222;">`],
  [/<ol>/g, `<ol style="margin: 0 0 16px; padding-left: 28px; font-family: ${SERIF}; font-size: 16px; line-height: 1.5; color: #222222;">`],
  [/<ul>/g, `<ul style="margin: 0 0 16px; padding-left: 28px; font-family: ${SERIF}; font-size: 16px; line-height: 1.5; color: #222222;">`],
  [/<li>/g, '<li style="margin: 0 0 8px;">'],
  [/<a /g, '<a style="color: #222222; text-decoration: underline; word-break: break-all;" '],
  [/<h([1-3])>/g, `<h$1 style="margin: 0 0 12px; font-family: ${SERIF}; font-size: 18px; color: #222222;">`],
];

const styleBody = (html) => BODY_STYLES.reduce((out, [pattern, replacement]) => out.replace(pattern, replacement), html || '');

/**
 * The recap as members get it: logo, a coloured banner carrying the title,
 * the body, the photo, then the address. `bodyHtml` is already-rendered
 * Markdown; everything else is escaped here.
 */
export function renderRecapHtml({ title, bodyHtml, headerImageUrl, photoUrl, bannerColor = '#1F6FC5' }) {
  const logo = isHttpsUrl(headerImageUrl)
    ? `<tr><td align="center" style="padding: 24px 24px 16px;"><img src="${escapeHtml(headerImageUrl)}" alt="UConsulting" width="160" style="display: block; width: 160px; max-width: 60%; height: auto; border: 0;" /></td></tr>`
    : '';
  const photo = isHttpsUrl(photoUrl)
    ? `<tr><td style="padding: 8px 24px 24px;"><img src="${escapeHtml(photoUrl)}" alt="" width="552" style="display: block; width: 100%; max-width: 552px; height: auto; border: 0; border-radius: 8px;" /></td></tr>`
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /></head>
<body style="margin: 0; padding: 0; background: #f2f2f2;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background: #f2f2f2;">
<tr><td align="center" style="padding: 24px 8px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width: 100%; max-width: 600px; background: #ffffff;">
${logo}
<tr><td align="center" style="background: ${bannerColor}; padding: 18px 24px;">
<h1 style="margin: 0; font-family: ${SERIF}; font-size: 30px; font-style: italic; font-weight: bold; color: #ffffff; letter-spacing: 0.5px;">${escapeHtml(title)}</h1>
</td></tr>
<tr><td style="padding: 24px 24px 8px;">
${styleBody(bodyHtml)}
</td></tr>
${photo}
</table>
<p style="margin: 16px 0 0; font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #555555;">${escapeHtml(FOOTER_ADDRESS)}</p>
</td></tr>
</table>
</body></html>`;
}

const bannerColor = async () => {
  try {
    return (await resolveEmailTheme()).accentColor;
  } catch {
    return undefined;
  }
};

/** A merge-field source for the person looking at it, as Master Communications' test send does. */
const mergeSourceFor = (user) => ({
  id: user.id,
  email: user.email,
  fullName: user.fullName || user.email,
  role: user.role,
  audience: 'user',
});

export async function renderRecapPreview({ recap, user }) {
  const source = mergeSourceFor(user);
  const html = renderRecapHtml({
    title: recap.title,
    bodyHtml: markdownToHtml(renderMessage(recap.body || '', source)),
    headerImageUrl: recap.headerImageUrl,
    photoUrl: recap.photoUrl,
    bannerColor: await bannerColor(),
  });
  return { subject: renderMessage(recap.subject || '', source), html };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const optionalUrl = (value, label) => {
  if (value == null || value === '') return null;
  const url = String(value).trim();
  if (url.length > LIMITS.url || !isHttpsUrl(url)) {
    throw fail(400, `${label} must be an https:// link.`, 'INVALID_IMAGE_URL');
  }
  return url;
};

const text = (value, label, max) => {
  if (value == null) return undefined;
  const s = String(value);
  if (s.length > max) throw fail(400, `${label} is too long (${max} characters at most).`, 'TOO_LONG');
  return s;
};

/** The editable fields present in `input`, checked. Absent fields stay absent. */
export function recapFields(input = {}) {
  const fields = {};
  if ('subject' in input) fields.subject = text(input.subject, 'Subject', LIMITS.subject) ?? '';
  if ('title' in input) fields.title = text(input.title, 'Banner title', LIMITS.title) ?? '';
  if ('body' in input) fields.body = text(input.body, 'Body', LIMITS.body) ?? '';
  if ('headerImageUrl' in input) fields.headerImageUrl = optionalUrl(input.headerImageUrl, 'Logo');
  if ('photoUrl' in input) fields.photoUrl = optionalUrl(input.photoUrl, 'Photo');
  return fields;
}

const assertSendable = (recap) => {
  const missing = ['subject', 'title', 'body'].filter((f) => !String(recap[f] ?? '').trim());
  if (missing.length) {
    throw fail(400, `Fill in the ${missing.join(', ')} before sending.`, 'INCOMPLETE');
  }
};

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

const isInterrupted = (recap, now = Date.now()) =>
  recap.status === RECAP_STATUS.SENDING && now - new Date(recap.updatedAt).getTime() > STUCK_SENDING_MS;

async function withPeople(recaps) {
  const ids = [...new Set(recaps.flatMap((r) => [r.createdById, r.updatedById, r.scheduledById]).filter(Boolean))];
  const users = ids.length
    ? await prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true, email: true } })
    : [];
  const byId = new Map(users.map((u) => [u.id, u.fullName || u.email]));
  return recaps.map((r) => ({
    ...r,
    createdByName: byId.get(r.createdById) ?? null,
    updatedByName: byId.get(r.updatedById) ?? null,
    scheduledByName: byId.get(r.scheduledById) ?? null,
    interrupted: isInterrupted(r),
  }));
}

export async function listRecaps({ limit = 100 } = {}) {
  const rows = await prisma.gmRecap.findMany({
    orderBy: { createdAt: 'desc' },
    take: Math.min(Math.max(parseInt(limit, 10) || 100, 1), 200),
  });
  return withPeople(rows);
}

export async function getRecap(id) {
  const recap = await prisma.gmRecap.findUnique({ where: { id } });
  if (!recap) throw fail(404, 'Recap not found', 'NOT_FOUND');
  return (await withPeople([recap]))[0];
}

/** How many people a send would reach right now. */
export async function recapAudience() {
  const { count } = await previewMasterCommunication(AUDIENCE);
  return { count, ...RECAP_SENDER };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * A new draft from the template. The logo and photo carry over from the latest
 * recap, so they are uploaded once and not every week.
 */
export async function createRecap({ userId, now = new Date() }) {
  const previous = await prisma.gmRecap.findMany({
    orderBy: { createdAt: 'desc' },
    take: 30,
    select: { title: true, headerImageUrl: true, photoUrl: true },
  });
  const theme = await resolveEmailTheme().catch(() => ({}));
  const template = templateFor(nextRecapWeek(previous.map((r) => r.title), now));
  const recap = await prisma.gmRecap.create({
    data: {
      ...template,
      headerImageUrl: previous.find((r) => r.headerImageUrl)?.headerImageUrl ?? theme.logoUrl ?? null,
      photoUrl: previous.find((r) => r.photoUrl)?.photoUrl ?? null,
      status: RECAP_STATUS.DRAFT,
      createdById: userId,
      updatedById: userId,
    },
  });
  return getRecap(recap.id);
}

const EDITABLE = [RECAP_STATUS.DRAFT, RECAP_STATUS.SCHEDULED];

export async function updateRecap({ id, userId, input }) {
  const fields = recapFields(input);
  const { count } = await prisma.gmRecap.updateMany({
    where: { id, status: { in: EDITABLE } },
    data: { ...fields, updatedById: userId },
  });
  if (count === 0) {
    await getRecap(id); // 404 if it is gone
    throw fail(409, 'This recap has already been sent and can no longer be edited.', 'NOT_EDITABLE');
  }
  return getRecap(id);
}

export async function deleteRecap({ id }) {
  const { count } = await prisma.gmRecap.deleteMany({ where: { id, status: RECAP_STATUS.DRAFT } });
  if (count === 0) {
    await getRecap(id);
    throw fail(409, 'Only a draft can be deleted. Cancel the schedule first.', 'NOT_DELETABLE');
  }
  return { id, deleted: true };
}

/**
 * Queue a recap. No `scheduledAt` means now: it is sent straight away by
 * `kick`, or by the next cron tick if that fails.
 */
export async function scheduleRecap({ id, userId, scheduledAt = null, now = new Date() }) {
  const recap = await getRecap(id);
  if (!EDITABLE.includes(recap.status)) {
    throw fail(409, 'This recap has already been sent.', 'NOT_EDITABLE');
  }
  assertSendable(recap);

  let when = now;
  if (scheduledAt) {
    when = new Date(scheduledAt);
    if (Number.isNaN(when.getTime())) throw fail(400, 'That is not a valid date and time.', 'INVALID_DATE');
    if (when.getTime() < now.getTime() - PAST_GRACE_MS) {
      throw fail(400, 'That time has already passed. Pick a time in the future, or send now.', 'IN_THE_PAST');
    }
    if (when.getTime() - now.getTime() > MAX_SCHEDULE_AHEAD_MS) {
      throw fail(400, 'Schedule it within the next year.', 'TOO_FAR_AHEAD');
    }
  }

  const { count } = await prisma.gmRecap.updateMany({
    where: { id, status: { in: EDITABLE } },
    data: { status: RECAP_STATUS.SCHEDULED, scheduledAt: when, scheduledById: userId },
  });
  if (count === 0) throw fail(409, 'This recap has already been sent.', 'NOT_EDITABLE');
  return getRecap(id);
}

/** Back to a draft. Refused once the cron has claimed it. */
export async function unscheduleRecap({ id }) {
  const { count } = await prisma.gmRecap.updateMany({
    where: { id, status: RECAP_STATUS.SCHEDULED },
    data: { status: RECAP_STATUS.DRAFT, scheduledAt: null, scheduledById: null },
  });
  if (count === 0) {
    await getRecap(id);
    throw fail(409, 'It is already sending, so it can no longer be cancelled.', 'NOT_SCHEDULED');
  }
  return getRecap(id);
}

/**
 * Settle a send whose server stopped, as FAILED. Sends nothing; the campaign
 * log shows who already has it. Refused while the heartbeat is still fresh.
 */
export async function markRecapFailed({ id }) {
  const { count } = await prisma.gmRecap.updateMany({
    where: { id, status: RECAP_STATUS.SENDING, updatedAt: { lt: new Date(Date.now() - STUCK_SENDING_MS) } },
    data: { status: RECAP_STATUS.FAILED },
  });
  if (count === 0) {
    await getRecap(id);
    throw fail(409, 'Only a send that has stopped making progress can be marked failed.', 'NOT_INTERRUPTED');
  }
  return getRecap(id);
}

/** The recap as it stands, mailed to the person asking only. */
export async function sendRecapTest({ id, user }) {
  if (!user?.email) throw fail(400, 'Your account has no email address.', 'NO_EMAIL');
  const recap = await getRecap(id);
  assertSendable(recap);
  const { subject, html } = await renderRecapPreview({ recap, user });
  const result = await sendEmail(user.email, `[TEST] ${subject}`, html, [], {
    category: 'TEST',
    trigger: 'MANUAL',
    recipientName: user.fullName || null,
    triggeredById: user.id,
    ...RECAP_SENDER,
  });
  if (!result.success) throw fail(502, result.error || 'The test email could not be sent.', 'SEND_FAILED');
  return { sentTo: user.email };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

async function sendClaimed(recap) {
  let lastBeat = Date.now();
  const heartbeat = async () => {
    if (Date.now() - lastBeat < HEARTBEAT_MS) return;
    lastBeat = Date.now();
    try {
      await prisma.gmRecap.updateMany({
        where: { id: recap.id, status: RECAP_STATUS.SENDING },
        data: { updatedAt: new Date() },
      });
    } catch (e) {
      console.error(`[gmRecaps] heartbeat for ${recap.id} failed:`, e);
    }
  };
  // Conditional, so an exec who already marked an interrupted send failed is
  // not overruled by a server that came back.
  const settle = (data) => prisma.gmRecap.updateMany({ where: { id: recap.id, status: RECAP_STATUS.SENDING }, data });

  try {
    const color = await bannerColor();
    const result = await sendMasterCommunication({
      ...AUDIENCE,
      channel: 'email',
      subject: recap.subject,
      body: recap.body,
      sentBy: recap.scheduledById || recap.createdById,
      sender: RECAP_SENDER,
      wrapHtml: (bodyHtml) =>
        renderRecapHtml({
          title: recap.title,
          bodyHtml,
          headerImageUrl: recap.headerImageUrl,
          photoUrl: recap.photoUrl,
          bannerColor: color,
        }),
      onCampaignLogged: (logId) => prisma.gmRecap.update({ where: { id: recap.id }, data: { messageLogId: logId } }),
      onProgress: heartbeat,
    });
    await settle({
      status: result.sent > 0 ? RECAP_STATUS.SENT : RECAP_STATUS.FAILED,
      sentAt: new Date(),
      messageLogId: result.logId ?? undefined,
      recipientCount: result.total,
      sentCount: result.sent,
      failedCount: result.failed,
    });
  } catch (e) {
    console.error(`[gmRecaps] send of ${recap.id} failed:`, e);
    await settle({ status: RECAP_STATUS.FAILED }).catch(() => {});
  }
}

let running = null;
let runAgain = false;

/**
 * Send every recap whose time has come. Returns how many this run sent. A run
 * already going in this process is not doubled: it goes round once more when
 * it finishes, so a "Send now" that arrived mid-run is not left for the next
 * tick. Other servers are kept out by the claim.
 */
export function processDueRecaps({ now = () => new Date() } = {}) {
  if (running) {
    runAgain = true;
    return running;
  }
  runAgain = false;
  running = (async () => {
    let processed = 0;
    try {
      const due = await prisma.gmRecap.findMany({
        where: { status: RECAP_STATUS.SCHEDULED, scheduledAt: { lte: now() } },
        orderBy: { scheduledAt: 'asc' },
        select: { id: true },
      });
      for (const { id } of due) {
        const { count } = await prisma.gmRecap.updateMany({
          where: { id, status: RECAP_STATUS.SCHEDULED, scheduledAt: { lte: now() } },
          data: { status: RECAP_STATUS.SENDING },
        });
        if (count === 0) continue; // another server, a cancel, or a reschedule got there first
        // Read after the claim, so the last edit before it is what goes out.
        const recap = await prisma.gmRecap.findUnique({ where: { id } });
        processed += 1;
        await sendClaimed(recap);
      }
    } catch (e) {
      console.error('[gmRecaps] processing due recaps failed:', e);
    }
    return processed;
  })().finally(() => {
    running = null;
    if (runAgain) processDueRecaps({ now });
  });
  return running;
}

/** Start sending without holding up the request that asked for it. */
export function kickRecapQueue() {
  processDueRecaps().catch((e) => console.error('[gmRecaps] kick failed:', e));
}
