import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import {
  isAttendanceOutstanding,
  setSlotAttendanceComplete,
  SlotAttendanceError,
} from './meetingAttendance.js';

vi.mock('../prismaClient.js', () => ({
  default: { meetingSlot: { findUnique: vi.fn(), update: vi.fn() } },
}));

const NOW = new Date('2026-09-27T17:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const at = (h) => new Date(NOW.getTime() + h * HOUR);

const slot = (overrides = {}) => ({
  id: 'slot-1',
  memberId: 'host-1',
  startTime: at(-3),
  endTime: at(-2.5),
  attendanceMarkedAt: null,
  signups: [{ attended: true }, { attended: false }],
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.meetingSlot.update.mockImplementation(({ data }) => Promise.resolve({ id: 'slot-1', ...data }));
});

describe('isAttendanceOutstanding', () => {
  it('is outstanding once the slot ends with someone unchecked', () => {
    expect(isAttendanceOutstanding(slot(), NOW)).toBe(true);
  });

  it('is done when marked done, even with someone unchecked (a no-show)', () => {
    expect(isAttendanceOutstanding(slot({ attendanceMarkedAt: at(-1) }), NOW)).toBe(false);
  });

  it('is done when everyone is checked, with no extra click', () => {
    expect(isAttendanceOutstanding(slot({ signups: [{ attended: true }] }), NOW)).toBe(false);
  });

  it('is not outstanding before the slot ends, or with nobody signed up', () => {
    expect(isAttendanceOutstanding(slot({ startTime: at(-0.25), endTime: at(0.25) }), NOW)).toBe(false);
    expect(isAttendanceOutstanding(slot({ signups: [] }), NOW)).toBe(false);
  });

  it('treats a slot with no end time as an hour long', () => {
    expect(isAttendanceOutstanding(slot({ startTime: at(-0.5), endTime: null }), NOW)).toBe(false);
    expect(isAttendanceOutstanding(slot({ startTime: at(-1.5), endTime: null }), NOW)).toBe(true);
  });
});

describe('setSlotAttendanceComplete', () => {
  it('records who finished it and when', async () => {
    prisma.meetingSlot.findUnique.mockResolvedValue(slot());
    await setSlotAttendanceComplete({ slotId: 'slot-1', complete: true, actorId: 'admin-1', now: NOW });

    expect(prisma.meetingSlot.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'slot-1' },
      data: { attendanceMarkedAt: NOW, attendanceMarkedById: 'admin-1' },
    }));
  });

  it('clears it when undone', async () => {
    prisma.meetingSlot.findUnique.mockResolvedValue(slot({ attendanceMarkedAt: at(-1) }));
    await setSlotAttendanceComplete({ slotId: 'slot-1', complete: false, actorId: 'admin-1', now: NOW });

    expect(prisma.meetingSlot.update.mock.calls[0][0].data).toEqual({
      attendanceMarkedAt: null,
      attendanceMarkedById: null,
    });
  });

  it('refuses a slot that has not started yet', async () => {
    prisma.meetingSlot.findUnique.mockResolvedValue(slot({ startTime: at(1), endTime: at(1.5) }));
    await expect(
      setSlotAttendanceComplete({ slotId: 'slot-1', complete: true, actorId: 'host-1', now: NOW })
    ).rejects.toMatchObject({ status: 409 });
    expect(prisma.meetingSlot.update).not.toHaveBeenCalled();
  });

  it("refuses a member finishing someone else's slot", async () => {
    prisma.meetingSlot.findUnique.mockResolvedValue(slot());
    await expect(
      setSlotAttendanceComplete({ slotId: 'slot-1', complete: true, actorId: 'm2', hostId: 'm2', now: NOW })
    ).rejects.toMatchObject({ status: 403 });
  });

  it('answers 404 for a slot that does not exist', async () => {
    prisma.meetingSlot.findUnique.mockResolvedValue(null);
    const err = await setSlotAttendanceComplete({ slotId: 'x', complete: true, actorId: 'a', now: NOW }).catch((e) => e);
    expect(err).toBeInstanceOf(SlotAttendanceError);
    expect(err.status).toBe(404);
  });
});
