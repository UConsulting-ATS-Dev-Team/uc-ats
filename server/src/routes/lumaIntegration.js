// The endpoints the hourly Luma sync routine talks to (docs/luma-sync-routine.md).
//
// There is no Luma API on our plan, so a scheduled Claude agent reads guests
// through the Luma MCP connector and posts them here. That makes the caller an
// agent holding a bearer token, not a signed-in person, which shapes this file:
//
//  - It is the only part of the ATS whose caller is a language model, and the
//    data it relays is text guests typed. Nothing here interprets that text:
//    the routine says which event and hands over the page, and every decision
//    about who a guest is happens in services/luma/ingestGuests.js.
//  - The routine is told which events to sync rather than choosing. `GET
//    /events` is the whole of what it may touch, and a page of guests is
//    accepted only for an event on that list, carrying the Luma event id the
//    ATS itself recorded.
//  - The routine's Claude account carries Luma *write* tools that cannot be
//    removed from it (create_blast, invite_guests, update_guest_status, ...).
//    Nothing here can prevent that; what it can do is make sure a routine that
//    has been talked into something cannot express it against the ATS.
import crypto from 'node:crypto';
import express from 'express';

import prisma from '../prismaClient.js';
import { ingestGuests } from '../services/luma/ingestGuests.js';
import { acceptedSyncTokens } from '../services/luma/syncToken.js';
import { CYCLE_AUDIENCE, resolveCycle } from '../services/activeCycle.js';

const router = express.Router();

// list_guests pages at 50. Twice that leaves room for a future page size while
// still bounding the work one request can ask for. The byte size of the body is
// bounded separately, by the app-wide express.json({ limit: '1mb' }) in
// index.js, which has already parsed the body by the time this router sees it -
// a limit set here would never be consulted.
const MAX_ENTRIES = 100;

const LUMA_EVENT_ID = /^evt-[A-Za-z0-9]+$/;

const DAY = 24 * 60 * 60 * 1000;
// How long an event stays on the routine's list: from a week before it starts
// (registrations are the point) until three days after (late door scans, and a
// pass over anything the routine missed while it was down).
const BEFORE_START = 7 * DAY;
const AFTER_START = 3 * DAY;

function tokenMatches(presented, expected) {
  // Digested first so two different lengths compare in constant time rather
  // than throwing, which would itself be a length oracle.
  const a = crypto.createHash('sha256').update(presented).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * A bearer token the ATS accepts for sync, compared in constant time.
 *
 * Resolved per request rather than at boot, like the SES webhook's topic ARN:
 * an unset value has to mean "refuse everything" at request time, not "the
 * server would not have started". That is also what lets a token generated in
 * Event Management work immediately, with no redeploy.
 *
 * Two tokens are accepted, not one — the generated one and LUMA_SYNC_TOKEN in
 * the environment (services/luma/syncToken.js explains why both).
 */
export async function requireLumaSyncToken(req, res, next) {
  let accepted;
  try {
    accepted = await acceptedSyncTokens();
  } catch (error) {
    console.error('[luma] could not read the sync token:', error);
    return res.status(500).json({ error: 'Could not verify the sync token' });
  }

  if (!accepted.length) {
    console.error('[luma] no sync token is configured; refusing all sync requests');
    return res.status(503).json({ error: 'Luma sync is not configured' });
  }

  const header = req.get('authorization') || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  // Every candidate is compared even once one has matched, so the work does not
  // depend on which token was presented.
  const matched = accepted.reduce((found, expected) => tokenMatches(presented, expected) || found, false);
  if (!presented || !matched) {
    return res.status(401).json({ error: 'Invalid sync token' });
  }
  return next();
}

router.use(requireLumaSyncToken);

/**
 * The cycles whose events the routine may sync.
 *
 * Both pointers are read, not just the candidate one. They are the same row
 * except during a handover, and an event under the other pointer would
 * otherwise stop syncing with no error at all - the failure this integration
 * has the least defence against (see the plan's accepted limitations).
 */
async function activeCycleIds() {
  const cycles = await Promise.all([
    resolveCycle(prisma, CYCLE_AUDIENCE.CANDIDATE),
    resolveCycle(prisma, CYCLE_AUDIENCE.ADMIN)
  ]);
  return [...new Set(cycles.filter(Boolean).map((cycle) => cycle.id))];
}

const syncWindow = () => {
  const now = Date.now();
  return { gte: new Date(now - AFTER_START), lte: new Date(now + BEFORE_START) };
};

// GET /api/integrations/luma/events
router.get('/events', async (req, res) => {
  try {
    const cycleIds = await activeCycleIds();
    if (!cycleIds.length) return res.json({ events: [] });

    const events = await prisma.events.findMany({
      where: {
        cycleId: { in: cycleIds },
        lumaUrl: { not: null },
        eventStartDate: syncWindow()
      },
      orderBy: { eventStartDate: 'asc' },
      select: {
        id: true,
        eventName: true,
        eventStartDate: true,
        lumaUrl: true,
        lumaEventId: true,
        lumaLastSyncedAt: true
      }
    });
    return res.json({ events });
  } catch (error) {
    console.error('[luma] failed to list events for sync:', error);
    return res.status(500).json({ error: 'Could not list events' });
  }
});

/**
 * The ATS event this request is about, or null if it is not one the routine may
 * touch. An event outside the window reads the same as one that does not exist:
 * the list is the permission, so anything off it is simply not there.
 */
async function syncableEvent(id) {
  if (typeof id !== 'string' || !id) return null;
  const cycleIds = await activeCycleIds();
  if (!cycleIds.length) return null;

  return prisma.events.findFirst({
    where: {
      id,
      cycleId: { in: cycleIds },
      lumaUrl: { not: null },
      eventStartDate: syncWindow()
    },
    select: { id: true, eventName: true, lumaUrl: true, lumaEventId: true }
  });
}

// POST /api/integrations/luma/events/:id/resolve  { lumaEventId }
//
// luma.com/<slug> is what an admin pastes; only lookup_entity can turn it into
// the evt-... id, so the routine reports what it resolved and the ATS records
// it. Recorded once: a second, different id is refused rather than followed,
// because it would re-point an event at another Luma event's guests, and the
// guests already stored under the first would silently become someone else's.
router.post('/events/:id/resolve', async (req, res) => {
  const lumaEventId = typeof req.body?.lumaEventId === 'string' ? req.body.lumaEventId.trim() : '';
  if (!LUMA_EVENT_ID.test(lumaEventId)) {
    return res.status(400).json({ error: 'lumaEventId must look like evt-...' });
  }

  try {
    const event = await syncableEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'No such event to sync' });

    // "Only if it is still unlinked" is the WHERE clause, not a branch on the
    // read above: two resolves naming different Luma events can both find it
    // unlinked, and a plain update would let the second silently re-point it
    // while both callers were told they had succeeded. The database decides,
    // and the loser is told so.
    const { count } = await prisma.events.updateMany({
      where: { id: event.id, lumaEventId: null },
      data: { lumaEventId }
    });

    if (count === 0) {
      const linked = await prisma.events.findUnique({
        where: { id: event.id },
        select: { lumaEventId: true }
      });
      // Already ours: the routine reporting the same id again, which is what
      // every run after the first one does.
      if (linked?.lumaEventId === lumaEventId) {
        return res.json({ id: event.id, lumaEventId, changed: false });
      }
      return res.status(409).json({
        error: 'This event is already linked to a different Luma event. An admin has to change it.',
        lumaEventId: linked?.lumaEventId ?? null
      });
    }

    console.log(`[luma] event ${event.id} ("${event.eventName}") resolved to ${lumaEventId}`);
    return res.json({ id: event.id, lumaEventId, changed: true });
  } catch (error) {
    // lumaEventId is unique: another ATS event already claims this Luma event.
    if (error?.code === 'P2002') {
      return res.status(409).json({ error: 'Another ATS event is already linked to that Luma event' });
    }
    console.error('[luma] failed to record a Luma event id:', error);
    return res.status(500).json({ error: 'Could not record the Luma event id' });
  }
});

// POST /api/integrations/luma/events/:id/guests
//   { lumaEventId, entries: [...], final?: boolean }
//
// One page of list_guests, relayed verbatim. `lumaEventId` is required and must
// equal the one the ATS recorded: the routine holds several events at once, and
// a page posted under the wrong id would file a whole event's guests against
// another event.
//
// `final` says this was the last page - the cursor ran out - and is the only
// thing that advances lumaLastSyncedAt. Only the routine knows where pagination
// ended, and that timestamp has to mean "the ATS has this event's whole guest
// list", not "something arrived": a routine that posts page one and then dies
// every hour would otherwise look permanently healthy.
router.post('/events/:id/guests', async (req, res) => {
  const lumaEventId = typeof req.body?.lumaEventId === 'string' ? req.body.lumaEventId.trim() : '';
  const entries = req.body?.entries;
  const final = req.body?.final;

  if (!LUMA_EVENT_ID.test(lumaEventId)) {
    return res.status(400).json({ error: 'lumaEventId must look like evt-...' });
  }
  if (!Array.isArray(entries)) {
    return res.status(400).json({ error: 'entries must be an array of list_guests entries' });
  }
  if (entries.length > MAX_ENTRIES) {
    return res.status(413).json({ error: `At most ${MAX_ENTRIES} entries per request` });
  }
  // Absent means "not the last page", so a routine that never sends it lets the
  // event go stale and be warned about - the safe direction for a signal whose
  // whole job is to warn. A `final` that is not a boolean is refused out loud
  // rather than read as false, because "true" the string would otherwise mean a
  // sync that silently never completes.
  if (final !== undefined && typeof final !== 'boolean') {
    return res.status(400).json({ error: 'final must be true or false' });
  }

  try {
    const event = await syncableEvent(req.params.id);
    if (!event) return res.status(404).json({ error: 'No such event to sync' });
    if (!event.lumaEventId) {
      return res.status(409).json({ error: 'This event has no Luma event id yet; resolve it first' });
    }
    if (event.lumaEventId !== lumaEventId) {
      return res.status(409).json({
        error: 'These guests are from a different Luma event',
        lumaEventId: event.lumaEventId
      });
    }

    const summary = await ingestGuests(event.id, entries);
    // Only a completed pass counts as a sync. A page in the middle has changed
    // real rows, and is reported as such, but it does not clear the warning.
    if (final === true) {
      await prisma.events.update({
        where: { id: event.id },
        data: { lumaLastSyncedAt: new Date() }
      });
    }

    console.log(
      `[luma] event ${event.id} ("${event.eventName}"): ${summary.received} guests, `
      + `${summary.rsvps.created} RSVPs added, ${summary.attendance.created} check-ins added, `
      + `${summary.unmatched.length} unmatched, ${summary.flagged.length} flagged, `
      + `${summary.unknownStatus.length} of unknown status, ${summary.rejected.length} rejected`
      + `${final === true ? ' (last page)' : ''}`
    );
    return res.json({ summary, synced: final === true });
  } catch (error) {
    console.error('[luma] failed to ingest a page of guests:', error);
    return res.status(500).json({ error: 'Could not ingest these guests' });
  }
});

export default router;
