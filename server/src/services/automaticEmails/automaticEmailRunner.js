import prisma from '../../prismaClient.js';
import { sendEmail } from '../emailNotifications.js';
import { applySuppressions, unsubscribeUrls } from '../emailSuppression.js';
import { findOccurrences } from './automaticEmailFinders.js';
import { renderAutomaticEmail } from './automaticEmails.js';

/**
 * Sends what every enabled automatic email owes, once. Run on a cron.
 *
 * A send is claimed before it is attempted: the SENDING row goes in first, and
 * the unique (automaticEmailId, subjectKey) means an overlapping run, or a
 * second server, gets P2002 and moves on. So nobody is emailed twice for the
 * same occurrence, whatever the timing.
 *
 * A row left SENDING by a crash mid-send is left alone rather than retried.
 * Whether that email went is unknowable, and a missing email is the lesser
 * failure than a duplicate one. FAILED rows are retried, three attempts in all.
 */

const MAX_ATTEMPTS = 3;
// Per email per run. A rule matching thousands at once (a status flipped in
// bulk, a big audience) drains over a few runs instead of in one burst.
const PER_RUN_LIMIT = 200;

async function existingSends(client, ruleId, keys) {
  const found = new Map();
  for (let i = 0; i < keys.length; i += 1000) {
    const rows = await client.automaticEmailSend.findMany({
      where: { automaticEmailId: ruleId, subjectKey: { in: keys.slice(i, i + 1000) } },
      select: { id: true, subjectKey: true, status: true, attempts: true },
    });
    for (const row of rows) found.set(row.subjectKey, row);
  }
  return found;
}

async function claim(client, rule, occurrence, existing) {
  if (!existing) {
    try {
      return await client.automaticEmailSend.create({
        data: { automaticEmailId: rule.id, subjectKey: occurrence.subjectKey, email: occurrence.email, status: 'SENDING', attempts: 1 },
      });
    } catch (error) {
      if (error?.code === 'P2002') return null; // another run has it
      throw error;
    }
  }
  // A retry: only the run that flips FAILED to SENDING gets to send.
  const { count } = await client.automaticEmailSend.updateMany({
    where: { id: existing.id, status: 'FAILED', attempts: { lt: MAX_ATTEMPTS } },
    data: { status: 'SENDING', attempts: { increment: 1 } },
  });
  return count ? { id: existing.id } : null;
}

async function runOne(rule, { client, now }) {
  const occurrences = await findOccurrences(rule, { client, now });
  if (occurrences.length === 0) return { sent: 0, failed: 0, suppressed: 0 };

  const existing = await existingSends(client, rule.id, occurrences.map((o) => o.subjectKey));
  const todo = occurrences
    .filter((o) => {
      const row = existing.get(o.subjectKey);
      return !row || (row.status === 'FAILED' && row.attempts < MAX_ATTEMPTS);
    })
    .slice(0, PER_RUN_LIMIT);
  if (todo.length === 0) return { sent: 0, failed: 0, suppressed: 0 };

  // Marketing mail skips the unsubscribed and carries the link; staff are
  // never marketing. Transactional mail ignores the list, as every other
  // automatic email does.
  let marketingFor = new Map();
  if (rule.marketing) {
    const { deliver, skipped } = await applySuppressions(todo.map((o) => ({ email: o.email, subjectKey: o.subjectKey })), client);
    marketingFor = new Map([
      ...deliver.map((r) => [r.subjectKey, { marketing: r.marketing, suppressed: false }]),
      ...skipped.map((r) => [r.subjectKey, { marketing: true, suppressed: true }]),
    ]);
  }

  const tally = { sent: 0, failed: 0, suppressed: 0 };
  for (const occurrence of todo) {
    const claimed = await claim(client, rule, occurrence, existing.get(occurrence.subjectKey));
    if (!claimed) continue;

    const status = marketingFor.get(occurrence.subjectKey);
    if (status?.suppressed) {
      await client.automaticEmailSend.update({
        where: { id: claimed.id },
        data: { status: 'SUPPRESSED', reason: 'Unsubscribed from marketing email' },
      });
      tally.suppressed += 1;
      continue;
    }

    const urls = status?.marketing ? unsubscribeUrls(occurrence.email) : null;
    let result;
    try {
      const { subject, html } = await renderAutomaticEmail(rule, occurrence.values, { unsubscribeUrl: urls?.page ?? null });
      result = await sendEmail(occurrence.email, subject, html, [], {
        category: 'CUSTOM_AUTOMATIC',
        recipientName: occurrence.values.fullName ?? null,
        attemptKey: `automatic-email:${claimed.id}`,
        listUnsubscribeUrl: urls?.oneClick ?? null,
      });
    } catch (error) {
      result = { success: false, error: error.message };
    }

    await client.automaticEmailSend.update({
      where: { id: claimed.id },
      data: result.success
        ? { status: 'SENT', sentAt: new Date(), reason: null }
        : { status: 'FAILED', reason: String(result.error ?? 'Send failed').slice(0, 500) },
    });
    tally[result.success ? 'sent' : 'failed'] += 1;
  }
  return tally;
}

/** One pass over every enabled automatic email. Returns totals for the log line. */
export async function runAutomaticEmails({ client = prisma, now = new Date() } = {}) {
  let rules;
  try {
    rules = await client.automaticEmail.findMany({ where: { enabled: true, enabledAt: { not: null } } });
  } catch (error) {
    // No table yet (migration not applied): nothing is enabled, so nothing is owed.
    console.error('[automaticEmails] skipped a run:', error?.message ?? error);
    return { sent: 0, failed: 0, suppressed: 0 };
  }

  const totals = { sent: 0, failed: 0, suppressed: 0 };
  for (const rule of rules) {
    try {
      const t = await runOne(rule, { client, now });
      for (const k of Object.keys(totals)) totals[k] += t[k];
    } catch (error) {
      // One broken rule (a deleted audience, a bad row) must not stop the rest.
      console.error(`[automaticEmails] "${rule.name}" (${rule.id}) failed:`, error);
    }
  }
  return totals;
}
