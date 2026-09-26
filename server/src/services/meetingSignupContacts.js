// How to reach the people booked into a Get to Know UC slot.
//
// A MeetingSignup keeps a name and an email and nothing else, so a phone number
// has to be found through the person's other records, matched by email:
//   1. their account's User.phoneNumber (set for members from the roster)
//   2. the number they gave in candidate onboarding
//   3. the number on their latest application
// Each is normalized to E.164, and one that does not normalize is skipped
// rather than guessed at - a wrong digit texts a stranger.
//
// 2 and 3 are only read when the signup's address belongs to an account that
// has verified it. Booking needs an account but not a verified one, so without
// this anybody could register with someone else's address, book, and have that
// person's application number handed to the host. User.phoneNumber needs no
// such check: only an admin can set it (see routes/users.js).
//
// A sealed candidate's onboarding and application are never read: the seal
// covers application content, and a sealed person is a member whose number,
// if the org has one, is already on their account.

import prisma from '../prismaClient.js';
import { normalizePhoneNumber } from '../utils/phone.js';
import { recordCommunications } from './communicationLog.js';

const lower = (email) => String(email || '').trim().toLowerCase();
const matchingAny = (emails) => emails.map((email) => ({ email: { equals: email, mode: 'insensitive' } }));

/**
 * [{ signupId, fullName, email, phoneNumber }] in the order given. phoneNumber
 * is E.164 or null.
 */
export async function resolveSignupContacts(signups = []) {
  const emails = [...new Set(signups.map((s) => lower(s.email)).filter(Boolean))];
  if (emails.length === 0) return [];

  const users = await prisma.user.findMany({
    where: { OR: matchingAny(emails) },
    select: { email: true, phoneNumber: true, emailVerifiedAt: true },
  });
  const verified = users.filter((u) => u.emailVerifiedAt).map((u) => lower(u.email));

  const [candidates, applications] = verified.length === 0
    ? [[], []]
    : await Promise.all([
        prisma.candidate.findMany({
          where: { OR: matchingAny(verified), recordsLockedAt: null },
          select: {
            email: true,
            onboarding: { select: { phoneNumber: true } },
          },
        }),
        // By the application's own email, not the candidate's: someone can apply
        // under one address and book under it while their Candidate row holds
        // another. Newest first, so the latest number is offered first.
        prisma.application.findMany({
          where: {
            OR: matchingAny(verified),
            NOT: { candidate: { recordsLockedAt: { not: null } } },
          },
          orderBy: { submittedAt: 'desc' },
          select: { email: true, phoneNumber: true },
        }),
      ]);

  const phoneByEmail = new Map();
  const offer = (email, raw) => {
    const key = lower(email);
    if (phoneByEmail.has(key)) return;
    const phone = normalizePhoneNumber(raw);
    if (phone) phoneByEmail.set(key, phone);
  };
  // Offered in order of preference; the first usable number for an email wins.
  for (const u of users) offer(u.email, u.phoneNumber);
  for (const c of candidates) offer(c.email, c.onboarding?.phoneNumber);
  for (const a of applications) offer(a.email, a.phoneNumber);

  return signups.map((s) => ({
    signupId: s.id,
    fullName: s.fullName,
    email: s.email,
    phoneNumber: phoneByEmail.get(lower(s.email)) ?? null,
  }));
}

const CONTACT_CHANNELS = ['imessage', 'email'];

/**
 * Record that a host opened a group iMessage or email to their slot's signups.
 *
 * Both leave through the host's own app (sms:// and mailto: links), so the
 * server never sees what was sent: each row is OPENED, one per person, so the
 * contact turns up under their name in the communications log.
 */
export async function logSignupContact({ channel, body, contacts, triggeredById }) {
  if (!CONTACT_CHANNELS.includes(channel)) {
    const err = new Error(`channel must be one of ${CONTACT_CHANNELS.join(', ')}`);
    err.status = 400;
    throw err;
  }
  const reached = contacts.filter((c) => (channel === 'imessage' ? c.phoneNumber : c.email));
  return recordCommunications(
    reached.map((c) => ({
      channel,
      category: 'MEETING',
      trigger: 'MANUAL',
      status: 'OPENED',
      recipient: channel === 'imessage' ? c.phoneNumber : c.email,
      recipientName: c.fullName,
      body: typeof body === 'string' ? body.slice(0, 5000) : null,
      triggeredById,
    }))
  );
}
