// Saving an in-person session never emails anyone. A save that moves its time
// or room marks it as having an update to send, and Send update sends it.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import prisma from '../prismaClient.js';
import { SessionUpdateRefused, notifySessionChanged, sendSessionUpdate } from '../services/sessionChangeNotices.js';
import interviewSlotsAdminRoutes from './interviewSlotsAdmin.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    interviewSlot: { findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn(), findMany: vi.fn() },
    // The virtual coffee chat guard asks first; these are in-person interviews.
    interview: { findUnique: vi.fn(async () => ({ isVirtual: false })), update: vi.fn() },
    // Interactive transactions run against the same mocks; arrays as a batch.
    $transaction: vi.fn(async (arg) => (typeof arg === 'function' ? arg(mockPrisma()) : Promise.all(arg))),
  },
}));

const mockPrisma = () => prisma;

vi.mock('../services/sessionChangeNotices.js', async (importOriginal) => ({
  ...(await importOriginal()),
  notifySessionChanged: vi.fn(),
  sendSessionUpdate: vi.fn(),
}));

let server;
let port;

const call = (method, path, body) =>
  fetch(`http://localhost:${port}/api/admin${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
const patch = (body) => call('PATCH', '/interviews/slots/slot-1', body);
const sendUpdate = () => call('POST', '/interviews/slots/slot-1/send-update');

const START = new Date('2026-10-08T16:00:00Z');
const END = new Date('2026-10-08T17:00:00Z');
const PENDING = new Date('2026-10-01T00:00:00Z');

const writtenData = () => prisma.interviewSlot.update.mock.calls[0][0].data;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', (req, res, next) => {
    req.user = { id: 'admin-1', role: 'ADMIN' };
    next();
  });
  app.use('/api/admin', interviewSlotsAdminRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.interview.findUnique.mockResolvedValue({ isVirtual: false });
  prisma.interviewSlot.findUnique.mockResolvedValue({
    startTime: START,
    endTime: END,
    location: 'Bunche 2150',
    updatePendingSince: null,
    interview: { location: 'Ackerman' },
  });
  prisma.interviewSlot.update.mockImplementation(async ({ data }) => ({ id: 'slot-1', ...data }));
  prisma.interviewSlot.updateMany.mockResolvedValue({ count: 1 });
  notifySessionChanged.mockResolvedValue({ candidates: 4, interviewers: 2 });
});

describe('PATCH /interviews/slots/:slotId', () => {
  it('marks a room change as an update to send, and emails nobody', async () => {
    const res = await patch({ location: 'Kerckhoff 131', notify: true });

    expect(res.status).toBe(200);
    expect(notifySessionChanged).not.toHaveBeenCalled();
    expect(writtenData().updatePendingSince).toBeInstanceOf(Date);
    expect((await res.json()).updatePendingSince).toBeTruthy();
  });

  it('marks a time change too', async () => {
    const later = new Date('2026-10-08T18:00:00Z');
    const laterEnd = new Date('2026-10-08T19:00:00Z');

    await patch({ startTime: later.toISOString(), endTime: laterEnd.toISOString() });

    expect(writtenData().updatePendingSince).toBeInstanceOf(Date);
    expect(notifySessionChanged).not.toHaveBeenCalled();
  });

  it('marks nothing when the time and place come out the same', async () => {
    // Clearing the session's own room to inherit the interview's, when the two
    // are the same room, changes nothing anyone was told.
    prisma.interviewSlot.findUnique.mockResolvedValue({
      startTime: START,
      endTime: END,
      location: 'Ackerman',
      updatePendingSince: null,
      interview: { location: 'Ackerman' },
    });

    await patch({ location: '', startTime: START.toISOString(), endTime: END.toISOString() });

    expect(writtenData()).not.toHaveProperty('updatePendingSince');
  });

  it('restamps a session that already had an update waiting', async () => {
    // A send in progress clears only the stamp it read, so a fresh one keeps
    // the button for details that send did not include.
    await patch({ location: 'Kerckhoff 131' });

    expect(writtenData().updatePendingSince.getTime()).toBeGreaterThan(PENDING.getTime());
  });

  it('marks nothing for a seat change', async () => {
    await patch({ candidateCapacity: 6 });

    expect(writtenData()).not.toHaveProperty('updatePendingSince');
  });

  it('refuses a missing session before writing', async () => {
    prisma.interviewSlot.findUnique.mockResolvedValue(null);

    const res = await patch({ location: 'Kerckhoff 131' });

    expect(res.status).toBe(404);
    expect(prisma.interviewSlot.update).not.toHaveBeenCalled();
  });
});

describe('POST /interviews/slots/:slotId/send-update', () => {
  // The claim, the clearing and when the button stays are sendSessionUpdate's,
  // tested in sessionChangeNotices.test.js. The route passes its answer on.
  it('sends the update and says whether the button stays', async () => {
    sendSessionUpdate.mockResolvedValue({ candidates: 4, interviewers: 2, failed: [], pending: false });

    const res = await sendUpdate();

    expect(res.status).toBe(200);
    expect(sendSessionUpdate).toHaveBeenCalledWith('slot-1');
    const body = await res.json();
    expect(body.notified).toMatchObject({ candidates: 4, interviewers: 2 });
    expect(body.notified).toHaveProperty('emailsOn');
    expect(body.pending).toBe(false);
  });

  it('answers a refusal with its status and code', async () => {
    sendSessionUpdate.mockRejectedValue(new SessionUpdateRefused(409, 'SEND_IN_PROGRESS', 'Someone is sending'));

    const res = await sendUpdate();

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'Someone is sending', code: 'SEND_IN_PROGRESS' });
  });

  it('refuses a virtual coffee chat, which emails from its own panel', async () => {
    prisma.interviewSlot.findUnique.mockResolvedValue({ interview: { isVirtual: true } });

    const res = await sendUpdate();

    expect(res.status).toBe(409);
    expect(sendSessionUpdate).not.toHaveBeenCalled();
  });
});

describe('changes made elsewhere in Edit Interview', () => {
  it('marks every session the whole-day move shifts', async () => {
    prisma.interviewSlot.findMany
      .mockResolvedValueOnce([
        { id: 'slot-1', startTime: START, endTime: END, updatePendingSince: null },
        { id: 'slot-2', startTime: START, endTime: END, updatePendingSince: PENDING },
      ])
      .mockResolvedValueOnce([{ startTime: START, endTime: END }]);

    const res = await call('POST', '/interviews/iv1/reschedule', { day: '2026-10-15' });

    expect(res.status).toBe(200);
    const [first, second] = prisma.interviewSlot.update.mock.calls.map(([arg]) => arg.data);
    expect(first.updatePendingSince).toBeInstanceOf(Date);
    // Restamped, as a session save would.
    expect(second.updatePendingSince.getTime()).toBeGreaterThan(PENDING.getTime());
    expect(notifySessionChanged).not.toHaveBeenCalled();
  });

  it('marks sessions that inherit the interview location when it changes', async () => {
    prisma.interview.findUnique.mockImplementation(async ({ select }) =>
      select?.location ? { location: 'Ackerman' } : { isVirtual: false }
    );
    prisma.interview.update.mockResolvedValue({ id: 'iv1', location: 'Kerckhoff' });
    prisma.interviewSlot.count = vi.fn(async () => 2);

    await call('PATCH', '/interviews/iv1', { location: 'Kerckhoff' });

    expect(prisma.interviewSlot.updateMany).toHaveBeenCalledWith({
      where: { interviewId: 'iv1', OR: [{ location: null }, { location: '' }] },
      data: { updatePendingSince: expect.any(Date) },
    });
  });
});
