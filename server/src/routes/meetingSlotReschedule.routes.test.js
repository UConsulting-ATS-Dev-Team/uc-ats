// Route-level coverage for rescheduling a GTKUC meeting slot.
//
// The behaviour that regressed before and is easy to regress again: a member
// could not move a slot at all once it had signups, and an admin could move one
// without anybody being told. Both paths now go through meetingSlotUpdates, so
// these assert the emails as much as the write.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import * as emails from '../services/emailNotifications.js';
import memberRoutes from './member.js';
import adminRoutes from './admin.js';

vi.mock('../prismaClient.js', () => {
  const meetingSlot = { findUnique: vi.fn(), update: vi.fn() };
  const meetingSignup = { count: vi.fn() };
  // The row lock the service takes before counting signups.
  const $queryRaw = vi.fn().mockResolvedValue([{ id: 'slot-1' }]);
  return {
    default: {
      user: { findUnique: vi.fn() },
      meetingSlot,
      meetingSignup,
      $queryRaw,
      meetingCommunication: { create: vi.fn().mockResolvedValue({ id: 'comm-1' }) },
      // The service uses the callback form; hand the callback the same mocks so
      // assertions can read the write that happened inside it.
      $transaction: vi.fn((arg) =>
        typeof arg === 'function' ? arg({ meetingSlot, meetingSignup, $queryRaw }) : Promise.all(arg)
      )
    }
  };
});

// Keep every real export (the module is imported for many other templates) and
// stub only the two sends under test.
vi.mock('../services/emailNotifications.js', async (importOriginal) => ({
  ...(await importOriginal()),
  sendMeetingRescheduleEmail: vi.fn().mockResolvedValue({ success: true }),
  sendMeetingRescheduleToMember: vi.fn().mockResolvedValue({ success: true })
}));

const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'admin@example.com', fullName: 'Admin' };
const hostMember = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'host@example.com', fullName: 'Host Member' };
const otherMember = { id: 'member-2', role: 'MEMBER', isActive: true, email: 'other@example.com', fullName: 'Other Member' };

// Far enough out that the past-check never trips as the suite ages.
const futureISO = (daysOut, hour) => {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + daysOut);
  d.setUTCHours(hour, 0, 0, 0);
  return d;
};

const ORIGINAL_START = futureISO(30, 18);
const ORIGINAL_END = futureISO(30, 19);

// The LA-local string a datetime-local input would submit.
const localInput = (date) => {
  const la = new Date(date).toLocaleString('en-US', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false
  });
  const [datePart, timePart] = la.split(', ');
  const [month, day, year] = datePart.split('/');
  return `${year}-${month}-${day}T${timePart}`;
};

const signups = [
  { id: 'signup-1', slotId: 'slot-1', fullName: 'Cand One', email: 'one@ucla.edu' },
  { id: 'signup-2', slotId: 'slot-1', fullName: 'Cand Two', email: 'two@ucla.edu' }
];

const existingSlot = (overrides = {}) => ({
  id: 'slot-1',
  memberId: hostMember.id,
  location: 'Kerckhoff 152',
  startTime: ORIGINAL_START,
  endTime: ORIGINAL_END,
  capacity: 2,
  signups,
  member: { id: hostMember.id, fullName: hostMember.fullName, email: hostMember.email },
  ...overrides
});

const tokenFor = (user) => jwt.sign({ userId: user.id }, process.env.JWT_SECRET);

let server;
let port;

const request = (path, { user, method = 'GET', body } = {}) => {
  const headers = {};
  if (user) headers.Authorization = `Bearer ${tokenFor(user)}`;
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(`http://localhost:${port}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {})
  });
};

// The calendar invite's organizer. Unset, every invite is skipped and the
// assertions below on what gets attached would have nothing to check.
const EMAIL_FROM = 'no-reply@uconsultingats.com';

// The DTSTART line an .ics carries for a Date.
const icsStart = (date) => `DTSTART:${date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`;

beforeAll(async () => {
  process.env.EMAIL_FROM = EMAIL_FROM;
  const app = express();
  app.use(express.json());
  app.use('/api/member', memberRoutes);
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
  prisma.user.findUnique.mockImplementation(({ where: { id } }) =>
    [adminUser, hostMember, otherMember].find((u) => u.id === id) || null
  );
  prisma.meetingSlot.findUnique.mockResolvedValue(existingSlot());
  prisma.meetingSignup.count.mockResolvedValue(signups.length);
  prisma.meetingSlot.update.mockImplementation(({ data }) =>
    Promise.resolve({ ...existingSlot(), ...data, communications: [] })
  );
});

describe('member rescheduling their own GTKUC slot', () => {
  // Both edit forms submit start and end together — the start picker rewrites
  // the end alongside it — so a move always carries both.
  const NEW_START = futureISO(31, 20);
  const NEW_END = futureISO(31, 21);

  it('moves a slot that already has signups and emails every candidate', async () => {
    const res = await request('/api/member/meeting-slots/slot-1', {
      user: hostMember,
      method: 'PUT',
      body: {
        location: 'Kerckhoff 152',
        startTime: localInput(NEW_START),
        endTime: localInput(NEW_END),
        capacity: 2
      }
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.notified).toEqual({
      candidates: 2,
      candidatesExpected: 2,
      host: false,
      // The host is the one making the change, so no host mail was due.
      hostExpected: false
    });

    expect(prisma.meetingSlot.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'slot-1' },
        data: expect.objectContaining({ startTime: NEW_START })
      })
    );

    expect(emails.sendMeetingRescheduleEmail).toHaveBeenCalledTimes(2);
    expect(emails.sendMeetingRescheduleEmail).toHaveBeenCalledWith(
      'one@ucla.edu',
      'Cand One',
      'Host Member',
      expect.objectContaining({ startTime: NEW_START }),
      expect.objectContaining({ startTime: ORIGINAL_START }),
      { invite: expect.objectContaining({ contentType: expect.stringContaining('method=REQUEST') }) }
    );

    // The invite carries the new time, so it moves the entry the confirmation made.
    const { invite } = emails.sendMeetingRescheduleEmail.mock.calls[0][5];
    expect(invite.content).toContain(icsStart(NEW_START));
    expect(invite.content).toContain('mailto:one@ucla.edu');

    // Both candidate notices are logged against their signup.
    expect(prisma.meetingCommunication.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'RESCHEDULED', signupId: 'signup-1', status: 'SENT' })
      })
    );
  });

  it('does not email the host about their own edit', async () => {
    const res = await request('/api/member/meeting-slots/slot-1', {
      user: hostMember,
      method: 'PUT',
      body: { startTime: localInput(NEW_START), endTime: localInput(NEW_END) }
    });

    expect(res.status).toBe(200);
    expect(emails.sendMeetingRescheduleEmail).toHaveBeenCalledTimes(2);
    expect(emails.sendMeetingRescheduleToMember).not.toHaveBeenCalled();
  });

  it('emails nobody when only capacity changes', async () => {
    const res = await request('/api/member/meeting-slots/slot-1', {
      user: hostMember,
      method: 'PUT',
      body: { capacity: 4 }
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ notified: { candidates: 0, host: false } });
    expect(emails.sendMeetingRescheduleEmail).not.toHaveBeenCalled();
  });

  it('refuses to move somebody else\'s slot', async () => {
    const res = await request('/api/member/meeting-slots/slot-1', {
      user: otherMember,
      method: 'PUT',
      body: { startTime: localInput(NEW_START) }
    });

    expect(res.status).toBe(403);
    expect(prisma.meetingSlot.update).not.toHaveBeenCalled();
    expect(emails.sendMeetingRescheduleEmail).not.toHaveBeenCalled();
  });

  it('refuses a capacity below the number already signed up', async () => {
    const res = await request('/api/member/meeting-slots/slot-1', {
      user: hostMember,
      method: 'PUT',
      body: { capacity: 1 }
    });

    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatch(/already signed up/i);
    expect(prisma.meetingSlot.update).not.toHaveBeenCalled();
  });

  it('refuses a move into the past', async () => {
    const res = await request('/api/member/meeting-slots/slot-1', {
      user: hostMember,
      method: 'PUT',
      body: { startTime: localInput(futureISO(-2, 18)) }
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/into the past/i);
    expect(prisma.meetingSlot.update).not.toHaveBeenCalled();
  });

  it('refuses an end time at or before the start', async () => {
    const res = await request('/api/member/meeting-slots/slot-1', {
      user: hostMember,
      method: 'PUT',
      body: { startTime: localInput(NEW_START), endTime: localInput(futureISO(31, 19)) }
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/after the start/i);
    expect(prisma.meetingSlot.update).not.toHaveBeenCalled();
  });

  it('answers 404 for a slot that does not exist', async () => {
    prisma.meetingSlot.findUnique.mockResolvedValue(null);

    const res = await request('/api/member/meeting-slots/nope', {
      user: hostMember,
      method: 'PUT',
      body: { startTime: localInput(NEW_START) }
    });

    expect(res.status).toBe(404);
  });
});

describe('admin rescheduling any GTKUC slot', () => {
  const NEW_START = futureISO(32, 21);
  const NEW_END = futureISO(32, 22);

  it('emails the signed-up candidates and the host member', async () => {
    const res = await request('/api/admin/meeting-slots/slot-1', {
      user: adminUser,
      method: 'PUT',
      body: {
        location: 'Ackerman 2410',
        startTime: localInput(NEW_START),
        endTime: localInput(NEW_END)
      }
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ notified: { candidates: 2, host: true } });

    expect(emails.sendMeetingRescheduleEmail).toHaveBeenCalledTimes(2);
    expect(emails.sendMeetingRescheduleToMember).toHaveBeenCalledWith(
      'host@example.com',
      'Host Member',
      expect.objectContaining({ location: 'Ackerman 2410', startTime: NEW_START }),
      expect.objectContaining({ location: 'Kerckhoff 152', startTime: ORIGINAL_START }),
      {
        signupCount: 2,
        invite: expect.objectContaining({ contentType: expect.stringContaining('method=REQUEST') }),
      }
    );

    const { invite } = emails.sendMeetingRescheduleToMember.mock.calls[0][4];
    expect(invite.content).toContain(icsStart(NEW_START));
    expect(invite.content).toContain('LOCATION:Ackerman 2410');
    expect(invite.content).toContain('mailto:host@example.com');
  });

  it('treats a location-only change as a reschedule', async () => {
    const res = await request('/api/admin/meeting-slots/slot-1', {
      user: adminUser,
      method: 'PUT',
      body: { location: 'Ackerman 2410' }
    });

    expect(res.status).toBe(200);
    expect(emails.sendMeetingRescheduleEmail).toHaveBeenCalledTimes(2);
  });

  it('emails nobody when only the host changes', async () => {
    const res = await request('/api/admin/meeting-slots/slot-1', {
      user: adminUser,
      method: 'PUT',
      body: { memberId: otherMember.id }
    });

    expect(res.status).toBe(200);
    expect(prisma.meetingSlot.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ memberId: otherMember.id }) })
    );
    expect(emails.sendMeetingRescheduleEmail).not.toHaveBeenCalled();
    expect(emails.sendMeetingRescheduleToMember).not.toHaveBeenCalled();
  });

  it('rejects an unknown host', async () => {
    const res = await request('/api/admin/meeting-slots/slot-1', {
      user: adminUser,
      method: 'PUT',
      body: { memberId: 'ghost-9' }
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/host member not found/i);
    expect(prisma.meetingSlot.update).not.toHaveBeenCalled();
  });

  it('denies a member the admin route', async () => {
    const res = await request('/api/admin/meeting-slots/slot-1', {
      user: hostMember,
      method: 'PUT',
      body: { startTime: localInput(NEW_START) }
    });

    expect(res.status).toBe(403);
    expect(prisma.meetingSlot.update).not.toHaveBeenCalled();
  });
});

describe('reschedule notification failures', () => {
  const NEW_START = futureISO(33, 17);
  const NEW_END = futureISO(33, 18);

  const move = (user, path) => request(path, {
    user,
    method: 'PUT',
    body: { startTime: localInput(NEW_START), endTime: localInput(NEW_END) }
  });

  // The senders catch provider errors and resolve with { success: false }
  // rather than throwing, so this is the shape a real refused delivery takes.
  it('logs a refused delivery as FAILED and leaves it out of the notified count', async () => {
    emails.sendMeetingRescheduleEmail.mockResolvedValueOnce({ success: false, error: 'SES rejected' });

    const res = await move(hostMember, '/api/member/meeting-slots/slot-1');

    expect(res.status).toBe(200);
    expect(prisma.meetingSlot.update).toHaveBeenCalled();
    expect(prisma.meetingCommunication.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'RESCHEDULED', status: 'FAILED', error: 'SES rejected' })
      })
    );

    // One of the two candidates was not reached, and the count says so.
    expect(await res.json()).toMatchObject({ notified: { candidates: 1 } });
  });

  // hostExpected true with host false is what lets the admin page warn that the
  // host still has the old time. Without the expected flag the page would see
  // host: false and could not tell a refused email from one never due.
  it('reports the host as expected but not notified when their email is refused', async () => {
    emails.sendMeetingRescheduleToMember.mockResolvedValueOnce({ success: false, error: 'SES rejected' });

    const res = await move(adminUser, '/api/admin/meeting-slots/slot-1');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      notified: { candidates: 2, candidatesExpected: 2, host: false, hostExpected: true }
    });
  });

  it('still saves the move and logs the failure when a send throws outright', async () => {
    emails.sendMeetingRescheduleEmail.mockRejectedValueOnce(new Error('socket hang up'));

    const res = await move(hostMember, '/api/member/meeting-slots/slot-1');

    expect(res.status).toBe(200);
    expect(prisma.meetingSlot.update).toHaveBeenCalled();
    expect(prisma.meetingCommunication.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'RESCHEDULED', status: 'FAILED', error: 'socket hang up' })
      })
    );
    expect(await res.json()).toMatchObject({ notified: { candidates: 1 } });
  });
});

describe('malformed times', () => {
  // localInputToUTC returns null for anything that is not YYYY-MM-DDTHH:mm.
  it('refuses a malformed start time instead of failing the write', async () => {
    const res = await request('/api/member/meeting-slots/slot-1', {
      user: hostMember,
      method: 'PUT',
      body: { startTime: 'next tuesday' }
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid start time/i);
    expect(prisma.meetingSlot.update).not.toHaveBeenCalled();
  });

  it('refuses a malformed end time instead of silently clearing it', async () => {
    const res = await request('/api/member/meeting-slots/slot-1', {
      user: hostMember,
      method: 'PUT',
      body: { endTime: 'half past four' }
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid end time/i);
    expect(prisma.meetingSlot.update).not.toHaveBeenCalled();
  });

  it('still allows clearing the end time with an empty value', async () => {
    const res = await request('/api/member/meeting-slots/slot-1', {
      user: hostMember,
      method: 'PUT',
      body: { endTime: null }
    });

    expect(res.status).toBe(200);
    expect(prisma.meetingSlot.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ endTime: null }) })
    );
  });
});

describe('capacity guard locking', () => {
  it('takes a row lock on the slot before counting signups', async () => {
    await request('/api/member/meeting-slots/slot-1', {
      user: hostMember,
      method: 'PUT',
      body: { capacity: 3 }
    });

    expect(prisma.$queryRaw).toHaveBeenCalled();
    const sqlParts = prisma.$queryRaw.mock.calls[0][0];
    expect(sqlParts.join('?')).toMatch(/FOR UPDATE/i);
  });
});
