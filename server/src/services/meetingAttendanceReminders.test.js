import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { sendMeetingAttendanceReminder } from './emailNotifications.js';
import {
  findSlotsDueForAttendanceReminder,
  sendDueAttendanceReminders,
} from './meetingAttendanceReminders.js';

vi.mock('../prismaClient.js', () => {
  const prisma = {
    meetingSlot: { findMany: vi.fn() },
    meetingCommunication: { create: vi.fn().mockResolvedValue({ id: 'comm-1' }), findMany: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn(),
  };
  return { default: prisma };
});

vi.mock('./emailNotifications.js', () => ({
  sendMeetingAttendanceReminder: vi.fn(),
}));

const NOW = new Date('2026-09-27T17:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const at = (hoursFromNow) => new Date(NOW.getTime() + hoursFromNow * HOUR);

// A half-hour slot that ended `hoursAgo` hours before NOW.
const slotEnded = (hoursAgo, communications = []) => ({
  id: 'slot-1',
  location: 'Kerckhoff Patio',
  startTime: at(-hoursAgo - 0.5),
  endTime: at(-hoursAgo),
  member: { id: 'host-1', fullName: 'Avery Chen', email: 'avery@ucla.edu', isActive: true },
  signups: [
    { id: 'su-1', fullName: 'Jordan Rivera', email: 'jordan@ucla.edu', attended: false },
    { id: 'su-2', fullName: 'Sam Patel', email: 'sam@ucla.edu', attended: true },
  ],
  communications,
});

const reminder = (hoursFromNow, status = 'SENT') => ({
  status,
  sentAt: at(hoursFromNow),
  recipient: 'avery@ucla.edu',
});

beforeEach(() => {
  vi.clearAllMocks();
  sendMeetingAttendanceReminder.mockResolvedValue({ success: true });
  prisma.$queryRaw.mockResolvedValue([{ locked: true }]);
  prisma.meetingCommunication.findMany.mockResolvedValue([]);
  prisma.$transaction.mockImplementation((fn) => fn(prisma));
});

describe('findSlotsDueForAttendanceReminder', () => {
  it('asks for slots that ended one to 25 hours ago with someone still unmarked', async () => {
    prisma.meetingSlot.findMany.mockResolvedValue([]);
    await findSlotsDueForAttendanceReminder(NOW);

    const { where } = prisma.meetingSlot.findMany.mock.calls[0][0];
    expect(where.OR).toEqual([
      { endTime: { gt: at(-25), lte: at(-1) } },
      // No end time: an hour-long slot, so it ended an hour after it started.
      { endTime: null, startTime: { gt: at(-26), lte: at(-2) } },
    ]);
    expect(where.signups).toEqual({ some: { attended: false } });
  });

  it('picks a slot that ended over an hour ago and has not been reminded', async () => {
    prisma.meetingSlot.findMany.mockResolvedValue([slotEnded(1.1)]);
    expect(await findSlotsDueForAttendanceReminder(NOW)).toHaveLength(1);
  });

  it('skips a slot already reminded since it ended', async () => {
    prisma.meetingSlot.findMany.mockResolvedValue([slotEnded(3, [reminder(-1.5)])]);
    expect(await findSlotsDueForAttendanceReminder(NOW)).toHaveLength(0);
  });

  it('reminds again when the slot was moved later after its reminder', async () => {
    // Reminded for an earlier time, then rescheduled: that reminder predates
    // the new end, so it does not count.
    prisma.meetingSlot.findMany.mockResolvedValue([slotEnded(2, [reminder(-10)])]);
    expect(await findSlotsDueForAttendanceReminder(NOW)).toHaveLength(1);
  });

  it('retries a failed send, but stops after three attempts', async () => {
    prisma.meetingSlot.findMany.mockResolvedValue([slotEnded(2, [reminder(-0.5, 'FAILED')])]);
    expect(await findSlotsDueForAttendanceReminder(NOW)).toHaveLength(1);

    prisma.meetingSlot.findMany.mockResolvedValue([
      slotEnded(2, [reminder(-0.75, 'FAILED'), reminder(-0.5, 'FAILED'), reminder(-0.25, 'FAILED')]),
    ]);
    expect(await findSlotsDueForAttendanceReminder(NOW)).toHaveLength(0);
  });

  it('does not remind a deactivated host', async () => {
    const slot = slotEnded(2);
    slot.member.isActive = false;
    prisma.meetingSlot.findMany.mockResolvedValue([slot]);
    expect(await findSlotsDueForAttendanceReminder(NOW)).toHaveLength(0);
  });
});

describe('sendDueAttendanceReminders', () => {
  it('emails the host with who signed up and a button to this slot', async () => {
    prisma.meetingSlot.findMany.mockResolvedValue([slotEnded(1.1)]);

    expect(await sendDueAttendanceReminders(NOW)).toBe(1);
    expect(sendMeetingAttendanceReminder).toHaveBeenCalledWith(
      'avery@ucla.edu',
      'Avery Chen',
      'Kerckhoff Patio',
      at(-1.6),
      at(-1.1),
      [
        { fullName: 'Jordan Rivera', email: 'jordan@ucla.edu', attended: false },
        { fullName: 'Sam Patel', email: 'sam@ucla.edu', attended: true },
      ],
      expect.stringMatching(/\/member\/meeting-slots\?slot=slot-1$/)
    );
  });

  it('logs the reminder against the slot, so the next run skips it', async () => {
    prisma.meetingSlot.findMany.mockResolvedValue([slotEnded(1.1)]);
    await sendDueAttendanceReminders(NOW);

    expect(prisma.meetingCommunication.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        slotId: 'slot-1',
        signupId: null,
        type: 'ATTENDANCE_REMINDER',
        recipient: 'avery@ucla.edu',
        status: 'SENT',
      }),
    });
  });

  it('skips a slot another instance is sending right now', async () => {
    // Old and new instances overlap during a deploy; only one may send.
    prisma.$queryRaw.mockResolvedValue([{ locked: false }]);
    prisma.meetingSlot.findMany.mockResolvedValue([slotEnded(1.1)]);

    expect(await sendDueAttendanceReminders(NOW)).toBe(0);
    expect(sendMeetingAttendanceReminder).not.toHaveBeenCalled();
  });

  it('skips a slot another instance already sent once the lock is free', async () => {
    // Both picked the slot; the other one sent and released the lock first.
    prisma.meetingSlot.findMany.mockResolvedValue([slotEnded(1.1)]);
    prisma.meetingCommunication.findMany.mockResolvedValue([reminder(-0.1)]);

    expect(await sendDueAttendanceReminders(NOW)).toBe(0);
    expect(sendMeetingAttendanceReminder).not.toHaveBeenCalled();
  });

  it('carries on to the next slot when one slot errors', async () => {
    prisma.meetingSlot.findMany.mockResolvedValue([slotEnded(1.1), { ...slotEnded(1.2), id: 'slot-2' }]);
    prisma.$queryRaw.mockRejectedValueOnce(new Error('connection reset'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await sendDueAttendanceReminders(NOW)).toBe(1);
    expect(sendMeetingAttendanceReminder).toHaveBeenCalledTimes(1);
  });

  it('logs a failed send as FAILED and does not count it', async () => {
    prisma.meetingSlot.findMany.mockResolvedValue([slotEnded(1.1)]);
    sendMeetingAttendanceReminder.mockResolvedValue({ success: false, error: 'SES throttled' });

    expect(await sendDueAttendanceReminders(NOW)).toBe(0);
    expect(prisma.meetingCommunication.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'ATTENDANCE_REMINDER', status: 'FAILED', error: 'SES throttled' }),
    });
  });
});
