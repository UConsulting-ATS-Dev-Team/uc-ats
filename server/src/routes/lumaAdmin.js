// What an admin does about the Luma guests the sync could not settle.
//
// ingestGuests decides who a guest is and writes their rows; when it cannot, it
// holds them. Until this router existed nothing read any of those holds - the
// plan called them "silent holds". What counts as held is services/luma/heldGuests.js.
//
// Everything in a guest record except the ids is text the guest typed into
// Luma. It is data: it is sent to the panel to be displayed and never
// interpreted here. The bulky parts (`raw`, `rawAnswers`) are not sent at all.
//
// Mounted at /api/admin/luma behind requireAuth + requireAdmin in index.js.
import express from 'express';

import prisma from '../prismaClient.js';
import { LUMA_HELD, holdsFor } from '../services/luma/heldGuests.js';
import { linkLumaGuest, LinkError } from '../services/luma/linkGuest.js';
import { buildSyncPrompt } from '../services/luma/syncPrompt.js';
import { clearSyncToken, getSyncTokenState, rotateSyncToken } from '../services/luma/syncToken.js';

const router = express.Router();

const MEMBER_ROLES = ['MEMBER', 'ADMIN'];
const MAX_SEARCH_RESULTS = 20;

const trimmed = (value) => (typeof value === 'string' ? value.trim() : '');

const GUEST_FIELDS = {
  lumaGuestId: true,
  name: true,
  email: true,
  uid: true,
  approvalStatus: true,
  registeredAt: true,
  checkedInAt: true,
  joinedAt: true,
  matchStatus: true,
  matchNote: true,
  candidate: { select: { id: true, firstName: true, lastName: true, email: true } },
  user: { select: { id: true, firstName: true, lastName: true, email: true } }
};

const present = (guest) => ({
  ...guest,
  member: guest.user ?? null,
  user: undefined,
  holds: holdsFor(guest)
});

/**
 * GET /api/admin/luma/events/:id/guests
 *
 * The held guests for one event, with the event's own sync state. `?all=true`
 * returns every guest instead, which is how a link made in error is found again
 * — a settled guest is no longer on hold, so nothing else would list them.
 */
router.get('/events/:id/guests', async (req, res) => {
  try {
    const event = await prisma.events.findUnique({
      where: { id: req.params.id },
      select: { id: true, eventName: true, lumaUrl: true, lumaEventId: true, lumaLastSyncedAt: true }
    });
    if (!event) return res.status(404).json({ error: 'Event not found' });

    const all = req.query.all === 'true';
    const [guests, total, held] = await Promise.all([
      prisma.lumaGuest.findMany({
        where: { eventId: event.id, ...(all ? {} : LUMA_HELD) },
        select: GUEST_FIELDS,
        orderBy: [{ matchStatus: 'asc' }, { name: 'asc' }]
      }),
      prisma.lumaGuest.count({ where: { eventId: event.id } }),
      prisma.lumaGuest.findMany({
        where: { eventId: event.id, ...LUMA_HELD },
        select: { matchStatus: true, matchNote: true, approvalStatus: true }
      })
    ]);

    const counts = { total, held: held.length, unmatched: 0, flagged: 0, unknownStatus: 0 };
    for (const guest of held) {
      for (const hold of holdsFor(guest)) counts[hold] += 1;
    }

    res.json({ event, counts, guests: guests.map(present) });
  } catch (error) {
    console.error('[GET /api/admin/luma/events/:id/guests]', error);
    res.status(500).json({ error: 'Failed to load Luma guests' });
  }
});

/**
 * POST /api/admin/luma/events/:id/guests/:lumaGuestId/link
 * Body: { candidateId } | { userId } | {} to unlink.
 */
router.post('/events/:id/guests/:lumaGuestId/link', async (req, res) => {
  try {
    const result = await linkLumaGuest({
      lumaGuestId: req.params.lumaGuestId,
      eventId: req.params.id,
      candidateId: trimmed(req.body?.candidateId) || undefined,
      userId: trimmed(req.body?.userId) || undefined,
      actorId: req.user?.id
    });
    res.json(result);
  } catch (error) {
    if (error instanceof LinkError) return res.status(error.status).json({ error: error.message });
    console.error('[POST /api/admin/luma/events/:id/guests/:lumaGuestId/link]', error);
    res.status(500).json({ error: 'Failed to link the guest' });
  }
});

/**
 * GET /api/admin/luma/people?q=
 *
 * Who a held guest can be linked to. Searched across every cycle, not just the
 * event's, for the same reason ingestGuests matches that way: the person a
 * guest turns out to be need not have applied this time round.
 */
router.get('/people', async (req, res) => {
  try {
    const query = trimmed(req.query?.q);
    if (query.length < 2) return res.json({ people: [] });

    const nameOrEmail = (extra = {}) => ({
      ...extra,
      OR: [
        { firstName: { contains: query, mode: 'insensitive' } },
        { lastName: { contains: query, mode: 'insensitive' } },
        { email: { contains: query, mode: 'insensitive' } }
      ]
    });

    const [candidates, members] = await Promise.all([
      prisma.candidate.findMany({
        // Sealed records are identity-only to everyone without an exec unlock,
        // and a sealed candidate has become a member, so their member account is
        // what a guest of theirs should be linked to. linkGuest refuses them too.
        where: nameOrEmail({ recordsLockedAt: null }),
        select: { id: true, firstName: true, lastName: true, email: true, studentId: true },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        take: MAX_SEARCH_RESULTS
      }),
      prisma.user.findMany({
        where: nameOrEmail({ role: { in: MEMBER_ROLES } }),
        select: { id: true, firstName: true, lastName: true, email: true, studentId: true },
        orderBy: [{ lastName: 'asc' }, { firstName: 'asc' }],
        take: MAX_SEARCH_RESULTS
      })
    ]);

    res.json({
      people: [
        ...members.map((person) => ({ ...person, kind: 'member' })),
        ...candidates.map((person) => ({ ...person, kind: 'candidate' }))
      ]
    });
  } catch (error) {
    console.error('[GET /api/admin/luma/people]', error);
    res.status(500).json({ error: 'Failed to search people' });
  }
});

/**
 * The sync token, and the routine prompt carrying it.
 *
 * This returns a live secret in a response body, which nothing else in the ATS
 * does. It is the feature: the token exists to be pasted into a Claude routine
 * by the admin setting the sync up, and a token they cannot read is a token
 * they cannot use. The router is already behind requireAuth + requireAdmin, and
 * services/luma/syncToken.js records what the token can actually reach.
 */
const tokenPayload = (state) => ({
  ...state,
  prompt: buildSyncPrompt({ token: state.token })
});

/**
 * These three responses carry a reusable bearer token, and the prompt repeats
 * it, so nothing between here and the browser may keep a copy: a cached body
 * would outlive both the dialog and the next rotation.
 */
const noStore = (res) => res.set('Cache-Control', 'no-store');

// GET /api/admin/luma/sync-token
router.get('/sync-token', async (req, res) => {
  try {
    noStore(res).json(tokenPayload(await getSyncTokenState()));
  } catch (error) {
    console.error('[GET /api/admin/luma/sync-token]', error);
    res.status(500).json({ error: 'Failed to read the sync token' });
  }
});

// POST /api/admin/luma/sync-token  — generate, replacing any existing one.
router.post('/sync-token', async (req, res) => {
  try {
    const state = await rotateSyncToken(req.user?.id);
    console.warn(`[luma] sync token generated by ${req.user?.id ?? 'unknown admin'}`);
    noStore(res).json(tokenPayload(state));
  } catch (error) {
    console.error('[POST /api/admin/luma/sync-token]', error);
    res.status(500).json({ error: 'Failed to generate a sync token' });
  }
});

// DELETE /api/admin/luma/sync-token — stop the generated token working.
router.delete('/sync-token', async (req, res) => {
  try {
    const state = await clearSyncToken(req.user?.id);
    console.warn(`[luma] sync token cleared by ${req.user?.id ?? 'unknown admin'}`);
    noStore(res).json(tokenPayload(state));
  } catch (error) {
    console.error('[DELETE /api/admin/luma/sync-token]', error);
    res.status(500).json({ error: 'Failed to clear the sync token' });
  }
});

export default router;
