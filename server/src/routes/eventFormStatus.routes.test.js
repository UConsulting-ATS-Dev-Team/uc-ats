// The form shim's durable state: PATCHing form links onto a timeline-generated
// event must persist PENDING_FORM -> CONNECTED (and back), so the state survives
// a refresh instead of being inferred from the URL fields in the UI.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import adminRoutes from './admin.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    events: { findUnique: vi.fn(), update: vi.fn() },
    recruitingCycle: { findUnique: vi.fn() },
    $transaction: vi.fn((ops) => Promise.all(ops))
  }
}));

const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'admin@example.com', fullName: 'Admin' };

const generatedEvent = (overrides = {}) => ({
  id: 'event-1',
  cycleId: 'cycle-1',
  eventName: 'Info Session',
  rsvpForm: null,
  attendanceForm: null,
  generatedFromStage: 'info_session',
  formStatus: 'PENDING_FORM',
  ...overrides
});

let server;
let port;
// The store the route writes into, so a follow-up read sees the persisted row.
let stored;

const patchEvent = (body) =>
  fetch(`http://localhost:${port}/api/admin/events/event-1`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${jwt.sign({ userId: adminUser.id }, process.env.JWT_SECRET)}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockResolvedValue(adminUser);
  stored = generatedEvent();
  prisma.events.findUnique.mockImplementation(async () => stored);
  prisma.events.update.mockImplementation(async ({ data }) => {
    stored = { ...stored, ...data };
    return stored;
  });
});

describe('PATCH /api/admin/events/:id form status', () => {
  it('connects a generated event once both form links are set, and it survives a refresh', async () => {
    const res = await patchEvent({
      rsvpForm: 'https://forms.gle/rsvp',
      attendanceForm: 'https://forms.gle/attendance'
    });

    expect(res.status).toBe(200);
    expect((await res.json()).formStatus).toBe('CONNECTED');
    // Persisted, not derived at render time.
    expect(prisma.events.update.mock.calls[0][0].data.formStatus).toBe('CONNECTED');
    expect(stored.formStatus).toBe('CONNECTED');
  });

  it('stays pending while only one link is present', async () => {
    const res = await patchEvent({ rsvpForm: 'https://forms.gle/rsvp' });

    expect((await res.json()).formStatus).toBe('PENDING_FORM');
    expect(prisma.events.update.mock.calls[0][0].data.formStatus).toBeUndefined();
  });

  it('reverts to pending when a link is cleared', async () => {
    stored = generatedEvent({
      rsvpForm: 'https://forms.gle/rsvp',
      attendanceForm: 'https://forms.gle/attendance',
      formStatus: 'CONNECTED'
    });

    const res = await patchEvent({ attendanceForm: '' });

    expect((await res.json()).formStatus).toBe('PENDING_FORM');
    expect(stored.formStatus).toBe('PENDING_FORM');
  });

  it('leaves a manual event unlabeled', async () => {
    stored = generatedEvent({ generatedFromStage: null, formStatus: null });

    const res = await patchEvent({
      rsvpForm: 'https://forms.gle/rsvp',
      attendanceForm: 'https://forms.gle/attendance'
    });

    expect((await res.json()).formStatus).toBeNull();
    expect(prisma.events.update.mock.calls[0][0].data.formStatus).toBeUndefined();
  });

  it('does not touch the status when unrelated fields are edited', async () => {
    stored = generatedEvent({
      rsvpForm: 'https://forms.gle/rsvp',
      attendanceForm: 'https://forms.gle/attendance',
      formStatus: 'CONNECTED'
    });

    const res = await patchEvent({ eventLocation: 'Kerckhoff 300' });

    expect((await res.json()).formStatus).toBe('CONNECTED');
    expect(prisma.events.update.mock.calls[0][0].data.formStatus).toBeUndefined();
  });
});
