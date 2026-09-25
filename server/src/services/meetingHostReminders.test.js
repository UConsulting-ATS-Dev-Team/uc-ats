import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { sendMeetingHostReminder } from './emailNotifications.js';
import { findSlotsDueForHostReminder, sendDueHostReminders } from './meetingHostReminders.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    meetingSlot: { findMany: vi.fn() },
    meetingCommunication: { create: vi.fn().mockResolvedValue({ id: 'comm-1' }) },
    user: { findMany: vi.fn().mockResolvedValue([]) },
    candidate: { findMany: vi.fn().mockResolvedValue([]) },
    application: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('./emailNotifications.js', () => ({
  sendMeetingHostReminder: vi.fn(),
}));

const NOW = new Date('2026-09-27T17:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const at = (hoursFromNow) => new Date(NOW.getTime() + hoursFromNow * HOUR);

const slotStarting = (hoursFromNow, communications = []) => ({
  id: 'slot-1',
  location: 'Kerckhoff Patio',
  startTime: at(hoursFromNow),
  endTime: at(hoursFromNow + 0.5),
  member: { id: 'host-1', fullName: 'Avery Chen', email: 'avery@ucla.edu', isActive: true },
  signups: [{ id: 'su-1', fullName: 'Jordan Rivera', email: 'jordan@ucla.edu' }],
  communications,
});

const reminder = (hoursFromNow, status = 'SENT') => ({
  status,
  sentAt: at(hoursFromNow),
  recipient: 'avery@ucla.edu',
});

beforeEach(() => {
  vi.clearAllMocks();
  sendMeetingHostReminder.mockResolvedValue({ success: true });
});

describe('findSlotsDueForHostReminder', () => {
  it('asks only for slots in the next 24 hours that someone booked', async () => {
    prisma.meetingSlot.findMany.mockResolvedValue([]);
    await findSlotsDueForHostReminder(NOW);

    const { where } = prisma.meetingSlot.findMany.mock.calls[0][0];
    expect(where.startTime).toEqual({ gt: NOW, lte: at(24) });
    expect(where.signups).toEqual({ some: {} });
  });

  it('picks a slot nobody has reminded yet', async () => {
    prisma.meetingSlot.findMany.mockResolvedValue([slotStarting(23)]);
    expect(await findSlotsDueForHostReminder(NOW)).toHaveLength(1);
  });

  it('skips a slot already reminded in this window', async () => {
    prisma.meetingSlot.findMany.mockResolvedValue([slotStarting(20, [reminder(-3)])]);
    expect(await findSlotsDueForHostReminder(NOW)).toHaveLength(0);
  });

  it('reminds again when the slot was moved to a later day after its reminder', async () => {
    // Reminded yesterday for a slot that was then pushed back: the old reminder
    // predates the new time's 24-hour window.
    prisma.meetingSlot.findMany.mockResolvedValue([slotStarting(20, [reminder(-10)])]);
    expect(await findSlotsDueForHostReminder(NOW)).toHaveLength(1);
  });

  it('retries a failed send, but stops after three attempts', async () => {
    prisma.meetingSlot.findMany.mockResolvedValue([slotStarting(20, [reminder(-1, 'FAILED')])]);
    expect(await findSlotsDueForHostReminder(NOW)).toHaveLength(1);

    prisma.meetingSlot.findMany.mockResolvedValue([
      slotStarting(20, [reminder(-1, 'FAILED'), reminder(-0.75, 'FAILED'), reminder(-0.5, 'FAILED')]),
    ]);
    expect(await findSlotsDueForHostReminder(NOW)).toHaveLength(0);
  });

  it('does not remind a deactivated host', async () => {
    const slot = slotStarting(20);
    slot.member.isActive = false;
    prisma.meetingSlot.findMany.mockResolvedValue([slot]);
    expect(await findSlotsDueForHostReminder(NOW)).toHaveLength(0);
  });
});

describe('sendDueHostReminders', () => {
  it('emails the host who signed up, with their number, and a link to the slot page', async () => {
    prisma.meetingSlot.findMany.mockResolvedValue([slotStarting(23)]);
    prisma.user.findMany.mockResolvedValue([{ email: 'jordan@ucla.edu', phoneNumber: null, emailVerifiedAt: new Date() }]);
    prisma.application.findMany.mockResolvedValue([{ email: 'Jordan@ucla.edu', phoneNumber: '(310) 555-1234' }]);

    expect(await sendDueHostReminders(NOW)).toBe(1);
    expect(sendMeetingHostReminder).toHaveBeenCalledWith(
      'avery@ucla.edu',
      'Avery Chen',
      'Kerckhoff Patio',
      at(23),
      at(23.5),
      [{ signupId: 'su-1', fullName: 'Jordan Rivera', email: 'jordan@ucla.edu', phoneNumber: '+13105551234' }],
      expect.stringMatching(/\/member\/meeting-slots$/)
    );
  });

  it('logs the reminder against the slot, so the next run skips it', async () => {
    prisma.meetingSlot.findMany.mockResolvedValue([slotStarting(23)]);
    await sendDueHostReminders(NOW);

    expect(prisma.meetingCommunication.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        slotId: 'slot-1',
        signupId: null,
        type: 'REMINDER',
        recipient: 'avery@ucla.edu',
        status: 'SENT',
      }),
    });
  });

  it('still sends when the number lookup fails, just without numbers', async () => {
    // A failed lookup must not become a FAILED attempt: three of those would
    // end the slot's reminder without an email ever being tried.
    prisma.meetingSlot.findMany.mockResolvedValue([slotStarting(23)]);
    prisma.user.findMany.mockRejectedValueOnce(new Error('connection reset'));
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await sendDueHostReminders(NOW)).toBe(1);
    expect(sendMeetingHostReminder.mock.calls[0][5]).toEqual([
      { signupId: 'su-1', fullName: 'Jordan Rivera', email: 'jordan@ucla.edu', phoneNumber: null },
    ]);
    expect(prisma.meetingCommunication.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ slotId: 'slot-1', status: 'SENT' }),
    });
  });

  it('logs a failed send as FAILED and does not count it', async () => {
    prisma.meetingSlot.findMany.mockResolvedValue([slotStarting(23)]);
    sendMeetingHostReminder.mockResolvedValue({ success: false, error: 'SES throttled' });

    expect(await sendDueHostReminders(NOW)).toBe(0);
    expect(prisma.meetingCommunication.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'REMINDER', status: 'FAILED', error: 'SES throttled' }),
    });
  });
});
