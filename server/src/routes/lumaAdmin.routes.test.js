// The admin side of the Luma sync: reading the guests it could not settle, and
// settling them by hand. What matters here is that the panel shows every kind
// of hold (an unmatched guest, a flagged one, a status we cannot read), that
// nothing of the guest's raw payload leaks into it, and that a link is handed
// to the service rather than written here.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';

import prisma from '../prismaClient.js';
import { linkLumaGuest, LinkError } from '../services/luma/linkGuest.js';
import routes from './lumaAdmin.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    events: { findUnique: vi.fn() },
    lumaGuest: { findMany: vi.fn(), count: vi.fn() },
    candidate: { findMany: vi.fn() },
    user: { findMany: vi.fn() },
    lumaSyncSetting: { findUnique: vi.fn(), upsert: vi.fn() }
  }
}));

vi.mock('../services/luma/linkGuest.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, linkLumaGuest: vi.fn() };
});

const EVENT = {
  id: 'event-1',
  eventName: 'Info Session',
  lumaUrl: 'https://lu.ma/f96xsz0q',
  lumaEventId: 'evt-jdRdVNKwbFxwg0B',
  lumaLastSyncedAt: new Date('2026-09-23T10:00:00.000Z')
};

const UNMATCHED = {
  lumaGuestId: 'gst-1',
  name: 'Unknown Person',
  email: 'nobody@example.com',
  uid: null,
  approvalStatus: 'approved',
  registeredAt: new Date('2026-09-20T00:00:00.000Z'),
  checkedInAt: null,
  joinedAt: null,
  matchStatus: 'UNMATCHED',
  matchNote: 'no UID answer; no candidate or member with nobody@example.com',
  candidate: null,
  user: null
};

const FLAGGED = {
  ...UNMATCHED,
  lumaGuestId: 'gst-2',
  name: 'Nickname',
  email: 'nick@example.com',
  uid: '405123456',
  matchStatus: 'MATCHED_CANDIDATE',
  matchNote: 'matched on the UID 405123456 alone',
  candidate: { id: 'cand-1', firstName: 'Real', lastName: 'Name', email: 'real@ucla.edu' }
};

const UNREADABLE = {
  ...UNMATCHED,
  lumaGuestId: 'gst-3',
  name: 'Session Guest',
  email: 'sess@example.com',
  approvalStatus: 'session',
  matchStatus: 'MATCHED_MEMBER',
  matchNote: null,
  user: { id: 'user-1', firstName: 'Mem', lastName: 'Ber', email: 'mem@ucla.edu' }
};

let server;
let port;

const call = (path, { method = 'GET', body } = {}) =>
  fetch(`http://localhost:${port}/api/admin/luma${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  // Stands in for the requireAuth + requireAdmin the real mount applies.
  app.use((req, _res, next) => {
    req.user = { id: 'admin-1', role: 'ADMIN' };
    next();
  });
  app.use('/api/admin/luma', routes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.events.findUnique.mockResolvedValue(EVENT);
  prisma.lumaGuest.findMany.mockResolvedValue([UNMATCHED, FLAGGED, UNREADABLE]);
  prisma.lumaGuest.count.mockResolvedValue(12);
  prisma.candidate.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.lumaSyncSetting.findUnique.mockResolvedValue(null);
  prisma.lumaSyncSetting.upsert.mockImplementation(({ create }) => Promise.resolve(create));
  delete process.env.LUMA_SYNC_TOKEN;
});

describe('GET /events/:id/guests', () => {
  it('returns the held guests with the event\'s own sync state', async () => {
    const res = await call('/events/event-1/guests');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.event).toMatchObject({ id: 'event-1', lumaEventId: 'evt-jdRdVNKwbFxwg0B' });
    expect(body.guests).toHaveLength(3);
  });

  it('says why each guest is being held, and a guest can be held twice over', async () => {
    const { guests } = await (await call('/events/event-1/guests')).json();
    const holds = Object.fromEntries(guests.map((g) => [g.lumaGuestId, g.holds]));

    expect(holds['gst-1']).toEqual(['unmatched', 'flagged']);
    expect(holds['gst-2']).toEqual(['flagged']);
    expect(holds['gst-3']).toEqual(['unknownStatus']);
  });

  it('counts the holds rather than the guests, so one guest can raise two', async () => {
    const { counts } = await (await call('/events/event-1/guests')).json();
    expect(counts).toEqual({ total: 12, held: 3, unmatched: 1, flagged: 2, unknownStatus: 1 });
  });

  it('presents the matched person as candidate or member, never as a bare user', async () => {
    const { guests } = await (await call('/events/event-1/guests')).json();
    const flagged = guests.find((g) => g.lumaGuestId === 'gst-2');
    const unreadable = guests.find((g) => g.lumaGuestId === 'gst-3');

    expect(flagged.candidate).toMatchObject({ id: 'cand-1' });
    expect(unreadable.member).toMatchObject({ id: 'user-1' });
    expect(unreadable).not.toHaveProperty('user.id');
  });

  it('never selects the stored Luma payload', async () => {
    await call('/events/event-1/guests');
    const select = prisma.lumaGuest.findMany.mock.calls[0][0].select;
    expect(select).not.toHaveProperty('raw');
    expect(select).not.toHaveProperty('rawAnswers');
  });

  it('asks only for held guests unless all=true', async () => {
    await call('/events/event-1/guests');
    expect(prisma.lumaGuest.findMany.mock.calls[0][0].where).toHaveProperty('OR');

    vi.clearAllMocks();
    prisma.events.findUnique.mockResolvedValue(EVENT);
    prisma.lumaGuest.findMany.mockResolvedValue([]);
    prisma.lumaGuest.count.mockResolvedValue(0);
    await call('/events/event-1/guests?all=true');
    expect(prisma.lumaGuest.findMany.mock.calls[0][0].where).toEqual({ eventId: 'event-1' });
  });

  it('404s an event that does not exist', async () => {
    prisma.events.findUnique.mockResolvedValue(null);
    expect((await call('/events/nope/guests')).status).toBe(404);
  });
});

describe('POST /events/:id/guests/:lumaGuestId/link', () => {
  it('hands the link to the service, scoped to the event in the path', async () => {
    linkLumaGuest.mockResolvedValue({ matchStatus: 'MATCHED_CANDIDATE' });

    const res = await call('/events/event-1/guests/gst-1/link', {
      method: 'POST',
      body: { candidateId: 'cand-9' }
    });

    expect(res.status).toBe(200);
    expect(linkLumaGuest).toHaveBeenCalledWith({
      lumaGuestId: 'gst-1',
      eventId: 'event-1',
      candidateId: 'cand-9',
      userId: undefined,
      actorId: 'admin-1'
    });
  });

  it('treats an empty body as an unlink rather than a link to nothing', async () => {
    linkLumaGuest.mockResolvedValue({ matchStatus: 'UNMATCHED' });

    await call('/events/event-1/guests/gst-1/link', { method: 'POST', body: {} });

    expect(linkLumaGuest).toHaveBeenCalledWith(
      expect.objectContaining({ candidateId: undefined, userId: undefined })
    );
  });

  it('answers with the status the service refused on, and its reason', async () => {
    linkLumaGuest.mockRejectedValue(new LinkError(409, 'records are sealed'));

    const res = await call('/events/event-1/guests/gst-1/link', {
      method: 'POST',
      body: { candidateId: 'cand-9' }
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('records are sealed');
  });

  it('does not leak an unexpected failure to the admin', async () => {
    linkLumaGuest.mockRejectedValue(new Error('connection terminated: password=hunter2'));

    const res = await call('/events/event-1/guests/gst-1/link', {
      method: 'POST',
      body: { candidateId: 'cand-9' }
    });

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to link the guest');
  });
});

describe('GET /people', () => {
  it('needs something to search on', async () => {
    const res = await call('/people?q=a');
    expect(await res.json()).toEqual({ people: [] });
    expect(prisma.candidate.findMany).not.toHaveBeenCalled();
  });

  it('returns members before candidates, each labelled with what they are', async () => {
    prisma.candidate.findMany.mockResolvedValue([{ id: 'c1', firstName: 'Cand', lastName: 'Idate', email: 'c@x' }]);
    prisma.user.findMany.mockResolvedValue([{ id: 'u1', firstName: 'Mem', lastName: 'Ber', email: 'm@x' }]);

    const { people } = await (await call('/people?q=be')).json();

    expect(people.map((p) => [p.kind, p.id])).toEqual([['member', 'u1'], ['candidate', 'c1']]);
  });

  it('leaves sealed candidates out of what can be linked', async () => {
    await call('/people?q=be');
    expect(prisma.candidate.findMany.mock.calls[0][0].where).toMatchObject({ recordsLockedAt: null });
  });

  it('searches members by role, not by everyone with an account', async () => {
    await call('/people?q=be');
    expect(prisma.user.findMany.mock.calls[0][0].where).toMatchObject({ role: { in: ['MEMBER', 'ADMIN'] } });
  });
});

// Setting the hourly sync up without leaving the app. This is the one endpoint
// in the ATS that returns a live secret in a response body, which is the whole
// feature: the token exists to be pasted into a Claude routine.
describe('the sync token', () => {
  const STORED = 'stored-token-long-enough-to-be-accepted-0';

  const stored = (token = STORED) =>
    prisma.lumaSyncSetting.findUnique.mockResolvedValue({
      token,
      tokenSetAt: new Date('2026-09-24T12:00:00.000Z'),
      updatedAt: new Date('2026-09-24T12:00:00.000Z'),
      updatedById: 'admin-1'
    });

  it('reports nothing configured before one exists', async () => {
    const body = await (await call('/sync-token')).json();
    expect(body).toMatchObject({ token: null, configured: false, envTokenSet: false });
  });

  it('returns the token itself, because it has to be pasted somewhere', async () => {
    stored();
    const body = await (await call('/sync-token')).json();
    expect(body.token).toBe(STORED);
  });

  it('hands back a prompt carrying the token', async () => {
    stored();
    const { prompt } = await (await call('/sync-token')).json();
    expect(prompt).toContain(`Authorization: Bearer ${STORED}`);
    expect(prompt).toContain('EVERY OTHER LUMA TOOL IS FORBIDDEN');
  });

  // Before anything is generated the prompt is still shown, so it must not read
  // as though it would work.
  it('does not render a usable prompt with no token', async () => {
    const { prompt } = await (await call('/sync-token')).json();
    expect(prompt).not.toContain('Bearer null');
    expect(prompt).toContain('Event Management');
  });

  it('generates a token and records the admin who did it', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const body = await (await call('/sync-token', { method: 'POST' })).json();
    const { create } = prisma.lumaSyncSetting.upsert.mock.calls[0][0];

    expect(create.updatedById).toBe('admin-1');
    expect(body.token).toBe(create.token);
    expect(body.prompt).toContain(create.token);
  });

  // A rotation that succeeded must not be reported as a failure: the previous
  // token is already dead, so the admin would be left with one nobody can read.
  it('still reports the new token when reading the row back would fail', async () => {
    prisma.lumaSyncSetting.findUnique.mockRejectedValue(new Error('read failed'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await call('/sync-token', { method: 'POST' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.token).toBeTruthy();
  });

  // The body is a reusable credential; nothing in between may keep a copy.
  it('marks every token response non-storable', async () => {
    stored();
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const get = await call('/sync-token');
    const post = await call('/sync-token', { method: 'POST' });
    const del = await call('/sync-token', { method: 'DELETE' });

    for (const res of [get, post, del]) {
      expect(res.headers.get('cache-control')).toContain('no-store');
    }
  });

  it('clears the stored token on delete', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await call('/sync-token', { method: 'DELETE' });
    expect(prisma.lumaSyncSetting.upsert.mock.calls[0][0].update).toMatchObject({ token: null });
  });

  // Clearing cannot reach the server's environment, and the panel says so.
  it('still reports the environment token as configured after a clear', async () => {
    process.env.LUMA_SYNC_TOKEN = 'env-token-long-enough-to-be-accepted-000';
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const body = await (await call('/sync-token', { method: 'DELETE' })).json();
    expect(body).toMatchObject({ token: null, envTokenSet: true, configured: true });
  });
});
