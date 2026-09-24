// Who has opted out of Master Communications marketing mail, and the links that
// let them.
//
// What counts as marketing is decided per recipient, not per send: a bulk send
// from Master Communications to anyone who is not active staff (an active
// MEMBER or ADMIN account). Staff mail is how the org runs, so it carries no
// unsubscribe link and ignores this table. Nothing outside Master
// Communications reads it either - decision letters, password resets and
// interview scheduling go out regardless, because someone who unsubscribed from
// recruiting news still has to hear whether they got in.
//
// The link carries a signed token rather than a database id. It proves the
// holder received mail at that address, which is all an unsubscribe needs, and
// nobody can unsubscribe someone else by editing a URL.

import crypto from 'node:crypto';
import prisma from '../prismaClient.js';
import config from '../config.js';
import { normalizeEmail } from '../utils/mailingListImport.js';

export const SUPPRESSION_REASONS = ['UNSUBSCRIBED', 'BOUNCED', 'COMPLAINED', 'ADMIN'];
export const SUPPRESSION_SOURCES = ['LINK', 'ONE_CLICK', 'SES', 'ADMIN'];

const STAFF_ROLES = ['MEMBER', 'ADMIN'];

const b64url = (buf) => Buffer.from(buf).toString('base64url');

function signature(email) {
  return crypto
    .createHmac('sha256', config.unsubscribeSecret || '')
    .update(`unsubscribe:${email}`)
    .digest()
    .subarray(0, 18)
    .toString('base64url');
}

export function unsubscribeToken(email) {
  const normalized = normalizeEmail(email);
  return `${b64url(normalized)}.${signature(normalized)}`;
}

/** The address a token was issued for, or null when it is not one of ours. */
export function readUnsubscribeToken(token) {
  if (typeof token !== 'string') return null;
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;

  let email;
  try {
    email = Buffer.from(encoded, 'base64url').toString('utf8');
  } catch {
    return null;
  }
  if (!email || email !== normalizeEmail(email)) return null;

  const expected = Buffer.from(signature(email));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  return email;
}

/**
 * `page` is the footer link: a page with a button, because mail scanners
 * follow every link in a message and a GET that unsubscribed would opt people
 * out without them ever reading the mail. `oneClick` is the List-Unsubscribe
 * target that Gmail and Yahoo POST to from their own Unsubscribe button.
 */
export function unsubscribeUrls(email) {
  const t = encodeURIComponent(unsubscribeToken(email));
  return {
    page: `${config.clientUrl}/unsubscribe?t=${t}`,
    oneClick: `${config.baseUrl}/api/unsubscribe/one-click?t=${t}`,
  };
}

export function unsubscribeFooterHtml(url) {
  return (
    `<div style="margin-top:32px;padding-top:12px;border-top:1px solid #e0e0e0;` +
    `font-family:Arial,sans-serif;font-size:12px;color:#888;line-height:1.5;">` +
    `You're receiving this because you've been in touch with UConsulting about recruiting. ` +
    `<a href="${url}" style="color:#888;">Unsubscribe</a> from these emails.` +
    `</div>`
  );
}

/**
 * Opt an address out. An address that is already opted out keeps its original
 * reason: the first thing that happened is the useful history, and an SES
 * bounce arriving for someone who already unsubscribed changes nothing about
 * whether we may email them.
 */
export async function suppressEmail({ email, reason, source, detail = null, messageLogId = null, createdById = null }, client = prisma) {
  const address = normalizeEmail(email);
  if (!address) {
    const err = new Error('email is required');
    err.status = 400;
    throw err;
  }
  if (!SUPPRESSION_REASONS.includes(reason) || !SUPPRESSION_SOURCES.includes(source)) {
    const err = new Error('Unknown suppression reason or source');
    err.status = 400;
    throw err;
  }

  const existing = await client.emailSuppression.findUnique({ where: { email: address } });
  if (existing && !existing.resubscribedAt) return existing;

  const data = {
    reason,
    source,
    detail: detail ? String(detail).slice(0, 2000) : null,
    messageLogId,
    createdById,
    resubscribedAt: null,
  };
  return client.emailSuppression.upsert({
    where: { email: address },
    create: { email: address, ...data },
    update: data,
  });
}

/** Opt back in. Keeps the row, so the history of the opt-out survives. */
export async function resubscribeEmail(email, client = prisma) {
  const address = normalizeEmail(email);
  const { count } = await client.emailSuppression.updateMany({
    where: { email: address, resubscribedAt: null },
    data: { resubscribedAt: new Date() },
  });
  return count > 0;
}

export async function isSuppressed(email, client = prisma) {
  const row = await client.emailSuppression.findUnique({
    where: { email: normalizeEmail(email) },
    select: { resubscribedAt: true },
  });
  return Boolean(row && !row.resubscribedAt);
}

/** The subset of `emails` currently opted out, lowercased. */
export async function loadSuppressedSet(emails, client = prisma) {
  const addresses = [...new Set((emails || []).map(normalizeEmail).filter(Boolean))];
  if (addresses.length === 0) return new Set();
  const rows = await client.emailSuppression.findMany({
    where: { email: { in: addresses }, resubscribedAt: null },
    select: { email: true },
  });
  return new Set(rows.map((r) => r.email));
}

/** The subset of `emails` that belong to active staff, lowercased. */
export async function loadStaffEmailSet(emails, client = prisma) {
  const addresses = [...new Set((emails || []).map(normalizeEmail).filter(Boolean))];
  if (addresses.length === 0) return new Set();
  const users = await client.user.findMany({
    where: {
      email: { in: addresses, mode: 'insensitive' },
      role: { in: STAFF_ROLES },
      isActive: true,
    },
    select: { email: true },
  });
  return new Set(users.map((u) => normalizeEmail(u.email)));
}

/**
 * Split a resolved audience into who is mailed and who is held back.
 *
 * Every recipient comes back tagged with `marketing`: true means the message
 * gets an unsubscribe footer and header. Staff are never marketing and never
 * held back.
 */
export async function applySuppressions(recipients, client = prisma) {
  const emails = recipients.map((r) => r.email);
  const [suppressed, staff] = await Promise.all([
    loadSuppressedSet(emails, client),
    loadStaffEmailSet(emails, client),
  ]);

  const deliver = [];
  const skipped = [];
  for (const r of recipients) {
    const key = normalizeEmail(r.email);
    const marketing = !staff.has(key);
    if (marketing && suppressed.has(key)) skipped.push({ ...r, marketing, skipReason: 'unsubscribed' });
    else deliver.push({ ...r, marketing });
  }
  return { deliver, skipped };
}

export async function listSuppressions({ search, includeResubscribed = false, limit = 100, offset = 0 } = {}) {
  const where = {};
  if (!includeResubscribed) where.resubscribedAt = null;
  if (search) where.email = { contains: String(search).trim().toLowerCase() };

  const take = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 500);
  const skip = Math.max(parseInt(offset, 10) || 0, 0);
  const [rows, total, byReason] = await Promise.all([
    prisma.emailSuppression.findMany({ where, orderBy: { updatedAt: 'desc' }, take, skip }),
    prisma.emailSuppression.count({ where }),
    prisma.emailSuppression.groupBy({ by: ['reason'], where: { resubscribedAt: null }, _count: { _all: true } }),
  ]);
  return {
    rows,
    total,
    activeByReason: Object.fromEntries(byReason.map((g) => [g.reason, g._count._all])),
  };
}
