import prisma from '../../prismaClient.js';
import { copySubject, mergeFieldsUsed } from '../emailCopyRender.js';
import { composeEmail, htmlToPlainText, part, withTestBanner } from '../emailLayout.js';
import { assertSafeMarkdown } from '../emailTemplateCopy.js';
import { BANNER_TONES, EMAIL_FORMATS } from '../emailTemplateStyle.js';
import { isHexColour } from '../emailTheme.js';
import { OWN_SIGN_OFF, signatureExists } from '../emailSignatures.js';
import { unsubscribeFooterHtml } from '../emailSuppression.js';
import { sendEmail } from '../emailNotifications.js';
import {
  SAMPLE_VALUES,
  TRIGGERS,
  describeTrigger,
  mergeFieldsFor,
  normalizeTrigger,
} from './automaticEmailRules.js';
import { findOccurrences, seedExisting } from './automaticEmailFinders.js';

/**
 * Automatic emails an admin writes: what they say, when they fire, and turning
 * them on and off. Sending is automaticEmailRunner.js.
 *
 * A new one is always saved disabled. Enabling is a separate, deliberate step,
 * because a trigger pointed at the wrong thing emails real candidates.
 */

const LIMITS = { name: 80, subject: 200, body: 10000 };
const SIGNATURE_ID = /^[0-9a-f-]{36}$/i;

const fail = (status, message, code = 'INVALID_AUTOMATIC_EMAIL') => Object.assign(new Error(message), { status, code });

const trimmed = (v) => (typeof v === 'string' ? v.trim() : '');

function checkMergeFields(label, text, allowed) {
  const unknown = mergeFieldsUsed(text).filter((name) => !allowed.includes(name));
  if (unknown.length) {
    throw fail(400, `${label} uses ${unknown.map((n) => `{{${n}}}`).join(', ')}, which this trigger cannot fill in`, 'UNKNOWN_MERGE_FIELD');
  }
}

/** Validates what an admin submitted. Throws 400 with a message they can act on. */
export async function normalizeAutomaticEmail(input, { client = prisma } = {}) {
  if (!input || typeof input !== 'object') throw fail(400, 'Nothing to save');

  const name = trimmed(input.name);
  const subject = trimmed(input.subject);
  const body = trimmed(input.body);
  if (!name) throw fail(400, 'Give the email a name');
  if (!subject) throw fail(400, 'The subject is empty');
  if (!body) throw fail(400, 'The email is empty');
  for (const [field, value] of Object.entries({ name, subject, body })) {
    if (value.length > LIMITS[field]) throw fail(400, `The ${field} is over ${LIMITS[field]} characters`);
  }
  if (/[\r\n]/.test(subject)) throw fail(400, 'The subject must be one line');

  const trigger = String(input.trigger ?? '');
  const triggerConfig = normalizeTrigger(trigger, input.triggerConfig);
  const allowed = mergeFieldsFor(trigger, triggerConfig);
  checkMergeFields('The subject', subject, allowed);
  checkMergeFields('The email', body, allowed);
  assertSafeMarkdown('The email', body);

  if (trigger === 'CYCLE_DATE') {
    const audience = await client.savedAudience.findUnique({ where: { id: triggerConfig.savedAudienceId }, select: { id: true } });
    if (!audience) throw fail(400, 'That saved audience no longer exists');
  }

  const format = String(input.format ?? 'DESIGNED').toUpperCase();
  if (!EMAIL_FORMATS.includes(format)) throw fail(400, 'Format must be Designed or Plain');
  const banner = trimmed(input.banner) || 'brand';
  if (!BANNER_TONES.includes(banner) && !isHexColour(banner)) throw fail(400, 'Unknown header colour');

  const signatureId = input.signatureId ? String(input.signatureId) : null;
  if (signatureId && signatureId !== OWN_SIGN_OFF && !SIGNATURE_ID.test(signatureId)) throw fail(400, 'Unknown signature');
  if (!(await signatureExists(signatureId, { client }))) throw fail(400, 'That signature no longer exists');

  return {
    name,
    trigger,
    triggerConfig,
    subject,
    body,
    // Sending to a saved audience is a bulk send by this app's own definition,
    // so it always honours unsubscribes; everything else is the admin's call.
    marketing: trigger === 'CYCLE_DATE' ? true : input.marketing === true,
    format,
    banner,
    signatureId,
  };
}

/**
 * The email for one recipient. `unsubscribeUrl` is set only for marketing mail
 * to someone who is not staff, which is who gets the footer.
 */
export async function renderAutomaticEmail(email, values, { unsubscribeUrl = null } = {}) {
  const parts = [
    part.copy(email.body),
    // An empty sign-off that a chosen or default signature replaces. With no
    // signature it renders nothing, which is what "no signature" means.
    part.signOff(''),
  ];
  if (unsubscribeUrl) parts.push(part.html(unsubscribeFooterHtml(unsubscribeUrl)));

  return composeEmail(`custom-${email.id ?? 'draft'}`, {
    subject: copySubject(email.subject, values),
    values,
    parts,
    style: { format: email.format, banner: email.banner, signatureId: email.signatureId ?? null },
  });
}

const shape = (row, stats = {}) => ({
  id: row.id,
  name: row.name,
  enabled: row.enabled,
  enabledAt: row.enabledAt,
  trigger: row.trigger,
  triggerConfig: row.triggerConfig,
  triggerSummary: describeTrigger(row.trigger, row.triggerConfig),
  subject: row.subject,
  body: row.body,
  marketing: row.marketing,
  format: row.format,
  banner: row.banner,
  signatureId: row.signatureId,
  mergeFields: mergeFieldsFor(row.trigger, row.triggerConfig),
  updatedAt: row.updatedAt,
  stats,
});

async function statsFor(ids, client) {
  if (ids.length === 0) return new Map();
  const rows = await client.automaticEmailSend.groupBy({
    by: ['automaticEmailId', 'status'],
    where: { automaticEmailId: { in: ids } },
    _count: { _all: true },
  });
  const byId = new Map();
  for (const r of rows) {
    const s = byId.get(r.automaticEmailId) ?? {};
    s[r.status] = r._count._all;
    byId.set(r.automaticEmailId, s);
  }
  return byId;
}

export async function listAutomaticEmails({ client = prisma } = {}) {
  const rows = await client.automaticEmail.findMany({ orderBy: [{ enabled: 'desc' }, { name: 'asc' }] });
  const stats = await statsFor(rows.map((r) => r.id), client);
  return rows.map((row) => shape(row, stats.get(row.id) ?? {}));
}

async function loadOrThrow(id, client) {
  const row = await client.automaticEmail.findUnique({ where: { id } });
  if (!row) throw fail(404, 'That automatic email no longer exists', 'UNKNOWN_AUTOMATIC_EMAIL');
  return row;
}

export async function getAutomaticEmail(id, { client = prisma } = {}) {
  const row = await loadOrThrow(id, client);
  const recent = await client.automaticEmailSend.findMany({
    where: { automaticEmailId: id, status: { not: 'SKIPPED' } },
    orderBy: { createdAt: 'desc' },
    take: 50,
    select: { email: true, status: true, reason: true, sentAt: true, createdAt: true },
  });
  return { ...shape(row, (await statsFor([id], client)).get(id) ?? {}), recent };
}

export async function createAutomaticEmail({ client = prisma, input, user }) {
  const data = await normalizeAutomaticEmail(input, { client });
  const row = await client.automaticEmail.create({
    data: { ...data, enabled: false, createdById: user?.id ?? null, updatedById: user?.id ?? null },
  });
  return getAutomaticEmail(row.id, { client });
}

const sameTrigger = (a, b) => a.trigger === b.trigger && JSON.stringify(a.triggerConfig) === JSON.stringify(b.triggerConfig);

/**
 * Saving an enabled email whose trigger changed moves `enabledAt` to now, as
 * turning it on would: a rule that used to watch "Rejected" and now watches
 * "Waitlisted" must not reach everyone already waitlisted.
 */
/**
 * Writes the rule and, when its cut moves, seeds the people it must skip - in
 * one transaction. The runner reads enabled rules outside it, so it sees the
 * new trigger and the skipped rows together or neither. Seeding after the
 * update instead leaves a moment where a run could email everybody already in
 * the status.
 */
async function writeRule(client, id, data, { seedFrom = null } = {}) {
  return client.$transaction(async (tx) => {
    // `seedFrom` is the rule as it will be once written: seeding reads its
    // trigger, which an enable-only update does not carry.
    if (seedFrom) await seedExisting({ ...seedFrom, id }, { client: tx });
    return tx.automaticEmail.update({ where: { id }, data });
  });
}

export async function updateAutomaticEmail({ client = prisma, id, input, user }) {
  const before = await loadOrThrow(id, client);
  const data = await normalizeAutomaticEmail(input, { client });
  const retrigger = before.enabled && !sameTrigger(before, data);

  await writeRule(
    client,
    id,
    { ...data, updatedById: user?.id ?? null, ...(retrigger ? { enabledAt: new Date() } : {}) },
    { seedFrom: retrigger ? data : null }
  );
  return getAutomaticEmail(id, { client });
}

/** Turning on records the moment; nothing from before it will trigger. */
export async function setAutomaticEmailEnabled({ client = prisma, id, enabled, user }) {
  const before = await loadOrThrow(id, client);
  if (before.enabled === enabled) return getAutomaticEmail(id, { client });

  await writeRule(
    client,
    id,
    { enabled, updatedById: user?.id ?? null, ...(enabled ? { enabledAt: new Date() } : {}) },
    { seedFrom: enabled ? before : null }
  );
  return getAutomaticEmail(id, { client });
}

export async function deleteAutomaticEmail({ client = prisma, id }) {
  const { count } = await client.automaticEmail.deleteMany({ where: { id } });
  if (count === 0) throw fail(404, 'That automatic email no longer exists', 'UNKNOWN_AUTOMATIC_EMAIL');
  return { deleted: id };
}

// ---------------------------------------------------------------------------
// Checking one before it goes live
// ---------------------------------------------------------------------------

/** An unsaved email, validated and rendered with sample values. */
export async function previewAutomaticEmail({ client = prisma, input }) {
  const email = await normalizeAutomaticEmail(input, { client });
  const values = Object.fromEntries(mergeFieldsFor(email.trigger, email.triggerConfig).map((f) => [f, SAMPLE_VALUES[f] ?? '']));
  const { subject, html } = await renderAutomaticEmail(email, values);
  return { subject, html, text: htmlToPlainText(html), mergeFields: Object.keys(values) };
}

export async function sendAutomaticEmailTest({ client = prisma, input, user }) {
  if (!user?.email) throw fail(400, 'No email address on your account');
  const { subject, html } = await previewAutomaticEmail({ client, input });
  const result = await sendEmail(
    user.email,
    `[TEST] ${subject}`,
    withTestBanner(html, 'only you received this. Names, dates and links are samples.'),
    [],
    { category: 'TEST', trigger: 'MANUAL', recipientName: user.fullName ?? null, triggeredById: user.id }
  );
  if (!result.success) throw fail(502, result.error || 'The test email could not be sent', 'SEND_FAILED');
  return { sentTo: user.email };
}

const LOOKBACK_DAYS = 7;

/**
 * "Who would this reach?" before turning it on. Runs the real finder as if the
 * email had been enabled a week ago, so an admin sees its scale in people
 * rather than guessing. For a status trigger it also says how many are in that
 * status now - the people enabling it will deliberately skip.
 */
export async function dryRunAutomaticEmail({ client = prisma, input, now = new Date() }) {
  const email = await normalizeAutomaticEmail(input, { client });
  const rule = { ...email, id: 'dry-run', enabledAt: new Date(now.getTime() - LOOKBACK_DAYS * 24 * 60 * 60 * 1000) };

  if (email.trigger === 'APPLICATION_STATUS') {
    const current = await findOccurrences(rule, { client, now });
    return {
      kind: 'status',
      alreadyInStatus: current.length,
      note: `${current.length} application(s) are in this status now. They will not be emailed: only applications that reach it after you turn this on will.`,
      sample: [],
    };
  }

  const occurrences = await findOccurrences(rule, { client, now });
  const lookback = email.trigger === 'RECORD_CREATED' ? `${LOOKBACK_DAYS} days` : '2 days';
  return {
    kind: 'lookback',
    count: occurrences.length,
    note: `Over the last ${lookback}, this would have sent ${occurrences.length} email(s). Turning it on sends none of those: only what happens from now on.`,
    sample: occurrences.slice(0, 10).map((o) => ({ name: o.values.fullName, email: o.email })),
  };
}

export { TRIGGERS };
