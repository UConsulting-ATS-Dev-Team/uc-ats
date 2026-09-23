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
import { CYCLE_AUDIENCE, resolveCycle } from '../services/activeCycle.js';

const router = express.Router();

// list_guests pages at 50. Twice that leaves room for a future page size while
// still bounding the work one request can ask for. The byte size of the body is
// bounded separately, by the app-wide express.json({ limit: '1mb' }) in
// index.js, which has already parsed the body by the time this router sees it -
// a limit set here would never be consulted.
const MAX_ENTRIES = 100;

// A sync token is machine-generated and lives in two configuration screens; it
// has no reason to be short, and this endpoint writes to the database. A token
// under this length reads as a placeholder somebody meant to replace, and is
// refused the same way as no token at all.
const MIN_TOKEN_LENGTH = 32;

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
 * Bearer LUMA_SYNC_TOKEN, compared in constant time.
 *
 * Read from the environment per request rather than from config.js, like the
 * SES webhook's topic ARN: an unset value has to mean "refuse everything" at
 * request time, not "the server would not have started".
 */
export function requireLumaSyncToken(req, res, next) {
  const expected = process.env.LUMA_SYNC_TOKEN || '';
  if (expected.length < MIN_TOKEN_LENGTH) {
    console.error('[luma] LUMA_SYNC_TOKEN is unset or too short; refusing all sync requests');
    return res.status(503).json({ error: 'Luma sync is not configured' });
  }

  const header = req.get('authorization') || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!presented || !tokenMatches(presented, expected)) {
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

    if (event.lumaEventId === lumaEventId) {
      return res.json({ id: event.id, lumaEventId, changed: false });
    }
    if (event.lumaEventId) {
      return res.status(409).json({
        error: 'This event is already linked to a different Luma event. An admin has to change it.',
        lumaEventId: event.lumaEventId
      });
    }

    await prisma.events.update({ where: { id: event.id }, data: { lumaEventId } });
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

// POST /api/integrations/luma/events/:id/guests  { lumaEventId, entries: [...] }
//
// One page of list_guests, relayed verbatim. `lumaEventId` is required and must
// equal the one the ATS recorded: the routine holds several events at once, and
// a page posted under the wrong id would file a whole event's guests against
// another event.
router.post('/events/:id/guests', async (req, res) => {
  const lumaEventId = typeof req.body?.lumaEventId === 'string' ? req.body.lumaEventId.trim() : '';
  const entries = req.body?.entries;

  if (!LUMA_EVENT_ID.test(lumaEventId)) {
    return res.status(400).json({ error: 'lumaEventId must look like evt-...' });
  }
  if (!Array.isArray(entries)) {
    return res.status(400).json({ error: 'entries must be an array of list_guests entries' });
  }
  if (entries.length > MAX_ENTRIES) {
    return res.status(413).json({ error: `At most ${MAX_ENTRIES} entries per request` });
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
    // Written after the page lands, because "last synced" is the only signal
    // anyone gets that this integration has stopped working.
    await prisma.events.update({
      where: { id: event.id },
      data: { lumaLastSyncedAt: new Date() }
    });

    console.log(
      `[luma] event ${event.id} ("${event.eventName}"): ${summary.received} guests, `
      + `${summary.rsvps.created} RSVPs added, ${summary.attendance.created} check-ins added, `
      + `${summary.unmatched.length} unmatched, ${summary.flagged.length} flagged, `
      + `${summary.unknownStatus.length} of unknown status, ${summary.rejected.length} rejected`
    );
    return res.json({ summary });
  } catch (error) {
    console.error('[luma] failed to ingest a page of guests:', error);
    return res.status(500).json({ error: 'Could not ingest these guests' });
  }
});

export default router;
