// Editing an in-person session's time or room with `notify` emails the people in
// it, and only when what they were told actually changed.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import prisma from '../prismaClient.js';
import { notifySessionChanged } from '../services/sessionChangeNotices.js';
import interviewSlotsAdminRoutes from './interviewSlotsAdmin.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    interviewSlot: { findUnique: vi.fn(), update: vi.fn() },
    // The virtual coffee chat guard asks first; these are in-person interviews.
    interview: { findUnique: vi.fn(async () => ({ isVirtual: false })) },
  },
}));

vi.mock('../services/sessionChangeNotices.js', async (importOriginal) => ({
  ...(await importOriginal()),
  notifySessionChanged: vi.fn(),
}));

let server;
let port;

const patch = (body) =>
  fetch(`http://localhost:${port}/api/admin/interviews/slots/slot-1`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const START = new Date('2026-10-08T16:00:00Z');
const END = new Date('2026-10-08T17:00:00Z');

const savedAs = (fields) => ({ id: 'slot-1', startTime: START, endTime: END, location: null, ...fields });

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
  prisma.interviewSlot.findUnique.mockResolvedValue({
    startTime: START,
    endTime: END,
    location: 'Bunche 2150',
    interview: { location: 'Ackerman' },
  });
  notifySessionChanged.mockResolvedValue({ candidates: 4, interviewers: 2 });
});

describe('PATCH /interviews/slots/:slotId with notify', () => {
  it('emails the session when its room changes', async () => {
    prisma.interviewSlot.update.mockResolvedValue(savedAs({ location: 'Kerckhoff 131' }));

    const res = await patch({ location: 'Kerckhoff 131', notify: true });

    expect(res.status).toBe(200);
    expect(notifySessionChanged).toHaveBeenCalledWith('slot-1');
    expect((await res.json()).notified).toMatchObject({ candidates: 4, interviewers: 2 });
  });

  it('emails the session when its time changes', async () => {
    const later = new Date('2026-10-08T18:00:00Z');
    const laterEnd = new Date('2026-10-08T19:00:00Z');
    prisma.interviewSlot.update.mockResolvedValue(
      savedAs({ startTime: later, endTime: laterEnd, location: 'Bunche 2150' })
    );

    const res = await patch({ startTime: later.toISOString(), endTime: laterEnd.toISOString(), notify: true });

    expect(res.status).toBe(200);
    expect(notifySessionChanged).toHaveBeenCalledWith('slot-1');
  });

  it('tells nobody when the time and place come out the same', async () => {
    // Clearing the session's own room to inherit the interview's, when the two
    // are the same room, changes nothing anyone was told.
    prisma.interviewSlot.findUnique.mockResolvedValue({
      startTime: START,
      endTime: END,
      location: 'Ackerman',
      interview: { location: 'Ackerman' },
    });
    prisma.interviewSlot.update.mockResolvedValue(savedAs({ location: null }));

    const res = await patch({ location: '', startTime: START.toISOString(), endTime: END.toISOString(), notify: true });

    expect(res.status).toBe(200);
    expect(notifySessionChanged).not.toHaveBeenCalled();
    expect((await res.json()).notified).toMatchObject({ unchanged: true, candidates: 0, interviewers: 0 });
  });

  it('tells nobody without notify, and reads nothing extra to decide', async () => {
    prisma.interviewSlot.update.mockResolvedValue(savedAs({ location: 'Kerckhoff 131' }));

    const res = await patch({ location: 'Kerckhoff 131' });

    expect(res.status).toBe(200);
    expect(notifySessionChanged).not.toHaveBeenCalled();
    // The one read is the virtual coffee chat guard's, which every location
    // edit already made.
    expect(prisma.interviewSlot.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.interviewSlot.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.not.objectContaining({ startTime: true }) })
    );
    expect((await res.json()).notified).toBeUndefined();
  });

  it('ignores notify on an edit that cannot change the time or place', async () => {
    prisma.interviewSlot.update.mockResolvedValue(savedAs({ candidateCapacity: 6 }));

    const res = await patch({ candidateCapacity: 6, notify: true });

    expect(res.status).toBe(200);
    expect(notifySessionChanged).not.toHaveBeenCalled();
  });

  it('keeps the save when the emails cannot be queued, and says so', async () => {
    prisma.interviewSlot.update.mockResolvedValue(savedAs({ location: 'Kerckhoff 131' }));
    notifySessionChanged.mockRejectedValue(new Error('database went away'));
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await patch({ location: 'Kerckhoff 131', notify: true });

    expect(res.status).toBe(200);
    expect(prisma.interviewSlot.update).toHaveBeenCalled();
    expect((await res.json()).notified).toMatchObject({ failed: ['candidates', 'interviewers'] });
    quiet.mockRestore();
  });

  it('refuses a missing session before writing', async () => {
    prisma.interviewSlot.findUnique.mockResolvedValue(null);

    const res = await patch({ location: 'Kerckhoff 131', notify: true });

    expect(res.status).toBe(404);
    expect(prisma.interviewSlot.update).not.toHaveBeenCalled();
  });
});
