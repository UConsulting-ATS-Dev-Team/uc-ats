// POST /interviews/:id/slot-signups - placing someone who never booked.
//
// The seat itself is placeCandidate's job (interviewSignups.place.test.js).
// What this pins is the route around it: the person placed hears about it, and
// a failed email never turns a placement that happened into an error.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import prisma from '../prismaClient.js';
import { placeCandidate } from '../services/interviewSignups.js';
import { queueNotifications, flushNotifications } from '../services/interviewSlotComms.js';
import interviewSlotsAdminRoutes from './interviewSlotsAdmin.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    application: { findUnique: vi.fn() },
    $transaction: vi.fn(async (fn) => fn({})),
  },
}));
vi.mock('../services/interviewSignups.js', async (importOriginal) => ({
  ...(await importOriginal()),
  placeCandidate: vi.fn(),
}));
vi.mock('../services/interviewSlotComms.js', async (importOriginal) => ({
  ...(await importOriginal()),
  queueNotifications: vi.fn(async () => ['n-1']),
  flushNotifications: vi.fn(async () => {}),
}));
vi.mock('../services/emailNotifications.js', async (importOriginal) => ({
  ...(await importOriginal()),
  slotNotificationSubject: vi.fn(async (type, title) => `${type}: ${title}`),
}));

let server;
let port;

const place = (body) =>
  fetch(`http://localhost:${port}/api/admin/interviews/iv-1/slot-signups`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

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
  placeCandidate.mockResolvedValue({
    placed: { id: 'su-1', slotId: 'slot-1', applicationId: 'app-1' },
    overCapacity: false,
    slot: { id: 'slot-1', interview: { title: 'Coffee Chat - Round 1' } },
  });
  prisma.application.findUnique.mockResolvedValue({ email: 'dee@ucla.edu' });
});

describe('POST /interviews/:id/slot-signups', () => {
  it('sends the person placed the same confirmation a self-booking gets', async () => {
    const res = await place({ slotId: 'slot-1', applicationId: 'app-1' });

    expect(res.status).toBe(201);
    expect(placeCandidate).toHaveBeenCalledWith(
      expect.objectContaining({ interviewId: 'iv-1', slotId: 'slot-1', applicationId: 'app-1', force: false })
    );
    expect(queueNotifications).toHaveBeenCalledWith(expect.anything(), [
      {
        slotId: 'slot-1',
        signupId: 'su-1',
        type: 'CONFIRMATION',
        recipient: 'dee@ucla.edu',
        subject: 'CONFIRMATION: Coffee Chat - Round 1',
      },
    ]);
    expect(flushNotifications).toHaveBeenCalledWith(['n-1'], expect.any(Function));
  });

  it('still reports the placement when the email cannot be queued', async () => {
    // The seat is committed. A 500 here would send the admin to retry, which
    // then 409s against the seat that was just made.
    queueNotifications.mockRejectedValueOnce(new Error('db down'));
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await place({ slotId: 'slot-1', applicationId: 'app-1' });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ placed: true, signupId: 'su-1' });
    spy.mockRestore();
  });

  it('emails nobody when the application has no address', async () => {
    prisma.application.findUnique.mockResolvedValue({ email: null });
    const res = await place({ slotId: 'slot-1', applicationId: 'app-1' });
    expect(res.status).toBe(201);
    expect(queueNotifications).not.toHaveBeenCalled();
  });
});
