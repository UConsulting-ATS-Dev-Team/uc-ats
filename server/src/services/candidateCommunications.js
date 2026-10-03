import prisma from '../prismaClient.js';
import { emailVariants } from '../utils/mailingListImport.js';

/**
 * Everything the communications log holds for one candidate, or a summary for
 * a page of them.
 *
 * The log keys a row on the address or number it went to, never on a person,
 * because most of what it records (password resets, Master Communications,
 * event confirmations) was sent to an address before anyone knew whose it was.
 * So "what have we sent this candidate" is answered by collecting everything
 * known to reach them and matching on that:
 *
 *   - addresses: the candidate's own, and the one on each of their
 *     applications, each in both UCLA spellings (x@g.ucla.edu and x@ucla.edu
 *     are one inbox). Their account shares the candidate's address, so it
 *     needs no lookup of its own.
 *   - numbers, for iMessage: each application's, their onboarding's, and the
 *     account's, compared on the last ten digits, because a roster import
 *     stores +13105551234 and a form stores (310) 555-1234.
 *
 * An address shared by two candidates shows the row on both. That is the
 * truth of what the log can say: the message went to that inbox.
 *
 * Identity only, so a sealed candidate's history is shown too. Nothing here is
 * a score, evaluation or answer, and the log is already open to every admin in
 * Master Communications.
 */

const MAX_PAGE = 200;
const MAX_SUMMARY_CANDIDATES = 200;

const ROW_SELECT = {
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
  sentAt: true,
  triggeredBy: { select: { id: true, fullName: true, email: true } },
  cycle: { select: { id: true, name: true } },
};

/** The last ten digits, or null when there are fewer than ten. */
export function phoneKey(raw) {
  const digits = String(raw ?? '').replace(/\D/g, '');
  return digits.length >= 10 ? digits.slice(-10) : null;
}

/** { [candidateId]: { emails: Set, phones: Set } } */
async function contactPointsFor(candidateIds, client) {
  const candidates = await client.candidate.findMany({
    where: { id: { in: candidateIds } },
    select: {
      id: true,
      email: true,
      applications: { select: { email: true, phoneNumber: true } },
      onboarding: { select: { phoneNumber: true } },
    },
  });

  const points = {};
  for (const c of candidates) {
    const emails = new Set();
    const phones = new Set();
    for (const address of [c.email, ...c.applications.map((a) => a.email)]) {
      for (const variant of emailVariants(address)) emails.add(variant);
    }
    for (const number of [...c.applications.map((a) => a.phoneNumber), c.onboarding?.phoneNumber]) {
      const key = phoneKey(number);
      if (key) phones.add(key);
    }
    points[c.id] = { emails, phones };
  }

  // A member's number lives on their account, found by the same address.
  const allEmails = [...new Set(Object.values(points).flatMap((p) => [...p.emails]))];
  if (allEmails.length) {
    const users = await client.user.findMany({
      where: { email: { in: allEmails }, phoneNumber: { not: null } },
      select: { email: true, phoneNumber: true },
    });
    for (const u of users) {
      const key = phoneKey(u.phoneNumber);
      if (!key) continue;
      for (const p of Object.values(points)) {
        if (p.emails.has(u.email.toLowerCase())) p.phones.add(key);
      }
    }
  }

  return points;
}

// The address or number a log row went to, in the form contact points use.
const PHONE_SQL = `right(regexp_replace(recipient, '\\D', '', 'g'), 10)`;

/**
 * Ids, newest first, of log rows sent to any of these addresses or numbers.
 * Raw because the match is on lower(recipient) and on the recipient's digits,
 * neither of which Prisma's filters can express.
 */
async function matchingRows(emails, phones, client, { limit = null, offset = 0 } = {}) {
  if (emails.length === 0 && phones.length === 0) return { rows: [], total: 0 };
  const where = `(lower(recipient) = ANY($1::text[]) OR (channel = 'imessage' AND ${PHONE_SQL} = ANY($2::text[])))`;

  const [rows, [{ total }]] = await Promise.all([
    client.$queryRawUnsafe(
      `SELECT id, lower(recipient) AS address, ${PHONE_SQL} AS phone, channel, category, status, "sentAt"
         FROM communication_logs WHERE ${where}
        ORDER BY "sentAt" DESC
        ${limit ? 'LIMIT $3 OFFSET $4' : ''}`,
      emails,
      phones,
      ...(limit ? [limit, offset] : [])
    ),
    client.$queryRawUnsafe(`SELECT count(*)::int AS total FROM communication_logs WHERE ${where}`, emails, phones),
  ]);
  return { rows, total };
}

/**
 * One candidate's messages, newest first, paged. `null` when there is no such
 * candidate. `matchedOn` is what was searched for, so the page can say why a
 * row is there.
 */
export async function listCandidateCommunications(candidateId, { limit = 50, offset = 0, client = prisma } = {}) {
  const take = Math.min(Math.max(parseInt(limit, 10) || 50, 1), MAX_PAGE);
  const skip = Math.max(parseInt(offset, 10) || 0, 0);

  const points = (await contactPointsFor([candidateId], client))[candidateId];
  if (!points) return null;

  const emails = [...points.emails];
  const phones = [...points.phones];
  const { rows: ids, total } = await matchingRows(emails, phones, client, { limit: take, offset: skip });

  const full = ids.length
    ? await client.communicationLog.findMany({ where: { id: { in: ids.map((r) => r.id) } }, select: ROW_SELECT })
    : [];
  const byId = new Map(full.map((r) => [r.id, r]));

  return {
    rows: ids.map((r) => byId.get(r.id)).filter(Boolean),
    total,
    limit: take,
    offset: skip,
    matchedOn: { emails, phones },
  };
}

/**
 * For a page of the candidate list: per candidate, how many messages and the
 * latest one's kind, date and status. One query for the whole page.
 */
export async function summarizeCandidateCommunications(candidateIds, { client = prisma } = {}) {
  const ids = [...new Set((candidateIds || []).filter((id) => typeof id === 'string' && id))];
  if (ids.length > MAX_SUMMARY_CANDIDATES) {
    throw Object.assign(new Error(`At most ${MAX_SUMMARY_CANDIDATES} candidates at once`), { status: 400 });
  }
  if (ids.length === 0) return {};

  const points = await contactPointsFor(ids, client);
  const emails = [...new Set(Object.values(points).flatMap((p) => [...p.emails]))];
  const phones = [...new Set(Object.values(points).flatMap((p) => [...p.phones]))];
  const { rows } = await matchingRows(emails, phones, client);

  const summary = Object.fromEntries(ids.map((id) => [id, { total: 0, latest: null }]));
  for (const [candidateId, p] of Object.entries(points)) {
    // Rows arrive newest first, so the first match is the latest.
    for (const row of rows) {
      const matches = p.emails.has(row.address) || (row.channel === 'imessage' && p.phones.has(row.phone));
      if (!matches) continue;
      const s = summary[candidateId];
      s.total += 1;
      if (!s.latest) s.latest = { category: row.category, channel: row.channel, status: row.status, sentAt: row.sentAt };
    }
  }
  return summary;
}
