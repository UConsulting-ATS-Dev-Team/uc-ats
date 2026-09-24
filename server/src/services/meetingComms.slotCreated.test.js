import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { sendMeetingSlotCreated } from './emailNotifications.js';
import { notifyHostSlotCreated } from './meetingComms.js';

vi.mock('../prismaClient.js', () => ({
  default: { meetingCommunication: { create: vi.fn().mockResolvedValue({ id: 'comm-1' }) } },
}));

vi.mock('./emailNotifications.js', () => ({
  sendMeetingSlotCreated: vi.fn(),
}));

beforeAll(() => {
  process.env.EMAIL_FROM = 'no-reply@uconsultingats.com';
});

beforeEach(() => {
  vi.clearAllMocks();
  sendMeetingSlotCreated.mockResolvedValue({ success: true });
});

const slot = {
  id: 'slot-1',
  location: 'Kerckhoff Patio',
  startTime: new Date('2026-09-28T16:30:00.000Z'),
  endTime: new Date('2026-09-28T17:00:00.000Z'),
};
const host = { email: 'avery@ucla.edu', fullName: 'Avery Chen' };

describe('notifyHostSlotCreated', () => {
  it('emails the host the slot with a calendar invite for it', async () => {
    const result = await notifyHostSlotCreated(slot, host);

    expect(result).toEqual({ ok: true });
    expect(sendMeetingSlotCreated).toHaveBeenCalledWith(
      'avery@ucla.edu',
      'Avery Chen',
      'Kerckhoff Patio',
      slot.startTime,
      slot.endTime,
      { invite: expect.objectContaining({ contentType: expect.stringContaining('method=PUBLISH') }) }
    );

    const { invite } = sendMeetingSlotCreated.mock.calls[0][5];
    expect(invite.content).toContain('DTSTART:20260928T163000Z');
    expect(invite.content).toContain('UID:gtkuc-host-slot-1@uconsultingats.com');
  });

  it('logs it against the slot as a host notification', async () => {
    await notifyHostSlotCreated(slot, host);

    expect(prisma.meetingCommunication.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        slotId: 'slot-1',
        signupId: null,
        type: 'HOST_NOTIFICATION',
        recipient: 'avery@ucla.edu',
        subject: 'Your Get to Know UC slot is open',
        status: 'SENT',
      }),
    });
  });

  it('logs a refused delivery as FAILED, and does not throw', async () => {
    sendMeetingSlotCreated.mockResolvedValue({ success: false, error: 'SMTP refused' });

    const result = await notifyHostSlotCreated(slot, host);

    expect(result.ok).toBe(false);
    expect(prisma.meetingCommunication.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ status: 'FAILED', error: 'SMTP refused' }),
    });
  });

  it('sends nothing for a host without an address', async () => {
    expect(await notifyHostSlotCreated(slot, { fullName: 'No Email' })).toEqual({ ok: false });
    expect(sendMeetingSlotCreated).not.toHaveBeenCalled();
  });
});
