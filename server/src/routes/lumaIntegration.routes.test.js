// The sync routine's endpoints. The caller is a scheduled agent holding a
// bearer token, so what is tested here is mostly what it is *not* allowed to
// do: reach anything without the token, touch an event outside the window it
// was given, re-point an event at a different Luma event, or post a page of
// guests under an id that is not the one the ATS recorded.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

import prisma from '../prismaClient.js';
import { ingestGuests } from '../services/luma/ingestGuests.js';
import routes from './lumaIntegration.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    recruitingCycle: { findFirst: vi.fn() },
    events: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn()
    }
  }
}));

vi.mock('../services/luma/ingestGuests.js', () => ({ ingestGuests: vi.fn() }));

const TOKEN = 'luma-sync-token-that-is-long-enough-000';
const CANDIDATE_CYCLE = { id: 'cycle-candidate', isActive: true };
const ADMIN_CYCLE = { id: 'cycle-admin', isAdminActive: true };

const EVENT = {
  id: 'event-1',
  eventName: 'Info Session',
  lumaUrl: 'https://luma.com/f96xsz0q',
  lumaEventId: 'evt-jdRdVNKwbFxwg0B'
};

const SUMMARY = {
  eventId: 'event-1',
  received: 2,
  rsvps: { created: 1, removed: 0 },
  attendance: { created: 1, removed: 0 },
  unmatched: [],
  flagged: [],
  unknownStatus: [],
  rejected: [],
  failed: []
};

let server;
let port;

const call = (path, { method = 'GET', body, token = TOKEN } = {}) =>
  fetch(`http://localhost:${port}/api/integrations/luma${path}`, {
    method,
    headers: {
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      'Content-Type': 'application/json'
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

// resolveCycle asks for the admin pointer first, then the candidate one.
const cyclesAre = ({ candidate = CANDIDATE_CYCLE, admin = ADMIN_CYCLE } = {}) => {
  prisma.recruitingCycle.findFirst.mockImplementation(({ where }) =>
    Promise.resolve(where.isAdminActive ? admin : candidate)
  );
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/integrations/luma', routes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  process.env.LUMA_SYNC_TOKEN = TOKEN;
  cyclesAre();
  prisma.events.findMany.mockResolvedValue([]);
  prisma.events.findFirst.mockResolvedValue(EVENT);
  prisma.events.findUnique.mockResolvedValue({ lumaEventId: EVENT.lumaEventId });
  prisma.events.update.mockResolvedValue({});
  // The conditional write: it lands only while the event is still unlinked.
  prisma.events.updateMany.mockImplementation(({ where }) =>
    Promise.resolve({ count: where.lumaEventId === null && !EVENT.lumaEventId ? 1 : 0 })
  );
  ingestGuests.mockResolvedValue(SUMMARY);
});

// An unlinked event, whose conditional resolve therefore lands.
const unlinked = () => {
  prisma.events.findFirst.mockResolvedValue({ ...EVENT, lumaEventId: null });
  prisma.events.updateMany.mockResolvedValue({ count: 1 });
};

describe('the sync token', () => {
  it('turns away a request with no token at all', async () => {
    const res = await call('/events', { token: null });
    expect(res.status).toBe(401);
    expect(prisma.events.findMany).not.toHaveBeenCalled();
  });

  it('turns away the wrong token', async () => {
    const res = await call('/events', { token: 'not-the-token-but-also-long-enough-000' });
    expect(res.status).toBe(401);
  });

  // The compare is over digests, so a token of a different length has to be
  // rejected like any other rather than throwing its way to a 500.
  it('turns away a token that is merely a prefix of the real one', async () => {
    const res = await call('/events', { token: TOKEN.slice(0, -1) });
    expect(res.status).toBe(401);
  });

  it('refuses everything while no token is configured', async () => {
    delete process.env.LUMA_SYNC_TOKEN;
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call('/events', { token: null });
    expect(res.status).toBe(503);
  });

  // A short token reads as a placeholder somebody meant to replace. Accepting
  // it would leave an endpoint that writes to the database behind a guessable
  // secret, so it is treated as no configuration at all.
  it('refuses everything while the configured token is too short', async () => {
    process.env.LUMA_SYNC_TOKEN = 'short';
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await call('/events', { token: 'short' });
    expect(res.status).toBe(503);
  });
});

describe('GET /events', () => {
  it('lists this cycle and the admin cycle, within the sync window', async () => {
    prisma.events.findMany.mockResolvedValue([EVENT]);
    const res = await call('/events');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ events: [EVENT] });

    const { where } = prisma.events.findMany.mock.calls[0][0];
    expect(where.cycleId.in).toEqual(['cycle-candidate', 'cycle-admin']);
    expect(where.lumaUrl).toEqual({ not: null });

    const now = Date.now();
    const days = (date) => Math.round((date.getTime() - now) / 86400000);
    expect(days(where.eventStartDate.gte)).toBe(-3);
    expect(days(where.eventStartDate.lte)).toBe(7);
  });

  // The handover case: during one, the two pointers are different rows, and an
  // event under the pointer we did not read would stop syncing silently.
  it('does not ask twice when both pointers are the same cycle', async () => {
    cyclesAre({ candidate: CANDIDATE_CYCLE, admin: CANDIDATE_CYCLE });
    await call('/events');
    expect(prisma.events.findMany.mock.calls[0][0].where.cycleId.in).toEqual(['cycle-candidate']);
  });

  it('lists nothing at all when no cycle is active', async () => {
    cyclesAre({ candidate: null, admin: null });
    const res = await call('/events');
    expect(await res.json()).toEqual({ events: [] });
    expect(prisma.events.findMany).not.toHaveBeenCalled();
  });
});

describe('POST /events/:id/resolve', () => {
  it('records the Luma event id an unresolved event was looked up to', async () => {
    unlinked();
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const res = await call('/events/event-1/resolve', {
      method: 'POST',
      body: { lumaEventId: 'evt-jdRdVNKwbFxwg0B' }
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 'event-1', lumaEventId: 'evt-jdRdVNKwbFxwg0B', changed: true });
    expect(prisma.events.updateMany).toHaveBeenCalledWith({
      where: { id: 'event-1', lumaEventId: null },
      data: { lumaEventId: 'evt-jdRdVNKwbFxwg0B' }
    });
  });

  // The guard is the WHERE clause, not the read before it. Two resolves naming
  // different Luma events can both find the event unlinked; without the
  // condition on the write, the second would silently re-point it and both
  // callers would be told they had succeeded.
  it('tells the loser of two overlapping resolves that it lost', async () => {
    prisma.events.findFirst.mockResolvedValue({ ...EVENT, lumaEventId: null });
    prisma.events.updateMany.mockResolvedValue({ count: 0 });
    prisma.events.findUnique.mockResolvedValue({ lumaEventId: 'evt-theOtherOne' });

    const res = await call('/events/event-1/resolve', {
      method: 'POST',
      body: { lumaEventId: 'evt-jdRdVNKwbFxwg0B' }
    });

    expect(res.status).toBe(409);
    expect((await res.json()).lumaEventId).toBe('evt-theOtherOne');
  });

  it('writes nothing when the same id is reported again', async () => {
    const res = await call('/events/event-1/resolve', {
      method: 'POST',
      body: { lumaEventId: EVENT.lumaEventId }
    });
    expect(res.status).toBe(200);
    expect((await res.json()).changed).toBe(false);
    expect(prisma.events.updateMany.mock.calls[0][0].where.lumaEventId).toBe(null);
  });

  // Following this would hand an event's guests to a different Luma event, and
  // quietly make the guests already stored under the first someone else's.
  it('refuses to re-point an event at a different Luma event', async () => {
    const res = await call('/events/event-1/resolve', {
      method: 'POST',
      body: { lumaEventId: 'evt-somethingElse' }
    });
    expect(res.status).toBe(409);
    expect((await res.json()).lumaEventId).toBe(EVENT.lumaEventId);
  });

  it('refuses an id that is not a Luma event id', async () => {
    const res = await call('/events/event-1/resolve', {
      method: 'POST',
      body: { lumaEventId: 'https://luma.com/f96xsz0q' }
    });
    expect(res.status).toBe(400);
    expect(prisma.events.findFirst).not.toHaveBeenCalled();
  });

  it('reports an id another ATS event already claims', async () => {
    prisma.events.findFirst.mockResolvedValue({ ...EVENT, lumaEventId: null });
    prisma.events.updateMany.mockRejectedValue(Object.assign(new Error('unique'), { code: 'P2002' }));
    const res = await call('/events/event-1/resolve', {
      method: 'POST',
      body: { lumaEventId: 'evt-jdRdVNKwbFxwg0B' }
    });
    expect(res.status).toBe(409);
  });

  // The list is the permission: an event in another cycle, without a Luma link,
  // or outside the window is not on it, and reads the same as one that is not
  // there at all.
  it('does not know about an event outside the window it was given', async () => {
    prisma.events.findFirst.mockResolvedValue(null);
    const res = await call('/events/event-9/resolve', {
      method: 'POST',
      body: { lumaEventId: 'evt-jdRdVNKwbFxwg0B' }
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /events/:id/guests', () => {
  const entries = [{ api_id: 'gst-1' }, { api_id: 'gst-2' }];
  const post = (body) => call('/events/event-1/guests', { method: 'POST', body });

  it('ingests the last page and records when the event was last synced', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await post({ lumaEventId: EVENT.lumaEventId, entries, final: true });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ summary: SUMMARY, synced: true });
    expect(ingestGuests).toHaveBeenCalledWith('event-1', entries);

    const [{ where, data }] = prisma.events.update.mock.calls[0];
    expect(where).toEqual({ id: 'event-1' });
    expect(data.lumaLastSyncedAt).toBeTruthy();
  });

  // The rows this page wrote are real; the sync is not finished. A routine that
  // posts page one and then dies every hour would otherwise look permanently
  // healthy, and the stale-sync warning would never fire for it.
  it('ingests a page in the middle without calling the event synced', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const res = await post({ lumaEventId: EVENT.lumaEventId, entries });

    expect(res.status).toBe(200);
    expect((await res.json()).synced).toBe(false);
    expect(ingestGuests).toHaveBeenCalledWith('event-1', entries);
    expect(prisma.events.update).not.toHaveBeenCalled();
  });

  // "true" the string is falsy here, which would be a sync that silently never
  // completes. Better to say so than to let it read as "not the last page".
  it('refuses a final flag that is not a boolean', async () => {
    const res = await post({ lumaEventId: EVENT.lumaEventId, entries, final: 'true' });
    expect(res.status).toBe(400);
    expect(ingestGuests).not.toHaveBeenCalled();
  });

  // The routine holds several events at once. A page posted under the wrong id
  // would file a whole event's guests against another event.
  it('refuses a page that came from a different Luma event', async () => {
    const res = await post({ lumaEventId: 'evt-somethingElse', entries });
    expect(res.status).toBe(409);
    expect(ingestGuests).not.toHaveBeenCalled();
  });

  it('refuses a page for an event whose Luma id is not recorded yet', async () => {
    prisma.events.findFirst.mockResolvedValue({ ...EVENT, lumaEventId: null });
    const res = await post({ lumaEventId: 'evt-jdRdVNKwbFxwg0B', entries });
    expect(res.status).toBe(409);
    expect(ingestGuests).not.toHaveBeenCalled();
  });

  it('refuses entries that are not a list', async () => {
    const res = await post({ lumaEventId: EVENT.lumaEventId, entries: { api_id: 'gst-1' } });
    expect(res.status).toBe(400);
    expect(ingestGuests).not.toHaveBeenCalled();
  });

  it('refuses more entries than a page of list_guests can hold', async () => {
    const res = await post({
      lumaEventId: EVENT.lumaEventId,
      entries: Array.from({ length: 101 }, (_, i) => ({ api_id: `gst-${i}` }))
    });
    expect(res.status).toBe(413);
    expect(ingestGuests).not.toHaveBeenCalled();
  });

  it('does not know about an event outside the window it was given', async () => {
    prisma.events.findFirst.mockResolvedValue(null);
    const res = await call('/events/event-9/guests', {
      method: 'POST',
      body: { lumaEventId: EVENT.lumaEventId, entries }
    });
    expect(res.status).toBe(404);
    expect(ingestGuests).not.toHaveBeenCalled();
  });

  // The routine retries on its next run, so a failed page must not be recorded
  // as a sync: "last synced" is the only warning anyone gets.
  it('leaves the last-synced time alone when the page cannot be ingested', async () => {
    ingestGuests.mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await post({ lumaEventId: EVENT.lumaEventId, entries, final: true });
    expect(res.status).toBe(500);
    expect(prisma.events.update).not.toHaveBeenCalled();
  });
});
