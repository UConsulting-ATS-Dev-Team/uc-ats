import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMeetingSignup, MeetingBookingConflictError } from './meetingBooking.js';
import prisma from '../prismaClient.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    recruitingCycle: { findFirst: vi.fn() },
    meetingSlot: { findUnique: vi.fn() },
    meetingSignup: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
}));

function makeSlot(overrides = {}) {
  return {
    id: 'slot-1',
    memberId: 'member-1',
    location: 'Zoom',
    startTime: new Date('2026-08-01T17:00:00.000Z'),
    endTime: new Date('2026-08-01T17:30:00.000Z'),
    capacity: 2,
    member: { fullName: 'Alice', email: 'alice@example.com' },
    ...overrides,
  };
}

function makeActiveCycle(overrides = {}) {
  return {
    id: 'cycle-1',
    isActive: true,
    startDate: new Date('2026-07-01T00:00:00.000Z'),
    endDate: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('meetingBooking', () => {
  function buildFakeDb({ slots, activeCycle } = {}) {
    const db = {
      activeCycle: activeCycle ?? makeActiveCycle(),
      slots: slots ?? { 'slot-1': makeSlot() },
      signups: [],
    };

    // Serialize transaction callbacks so concurrent tests are deterministic:
    // each callback runs to completion before the next one starts.
    let chain = Promise.resolve();
    prisma.$transaction = vi.fn((cb) => {
      const p = chain.then(async () => await cb(prisma));
      chain = p.catch(() => {});
      return p;
    });

    prisma.recruitingCycle.findFirst = vi.fn(() => Promise.resolve(db.activeCycle));

    prisma.meetingSignup.findMany = vi.fn(({ where: { email }, include }) => {
      const list = db.signups.filter((s) => s.email === email);
      if (include?.slot) {
        return list.map((s) => ({ ...s, slot: db.slots[s.slotId] }));
      }
      return list;
    });

    prisma.meetingSignup.findFirst = vi.fn(({ where: { email }, include }) => {
      const signup = db.signups.find((s) => s.email === email);
      if (!signup) return null;
      if (include?.slot) {
        return { ...signup, slot: db.slots[signup.slotId] };
      }
      return signup;
    });

    prisma.meetingSlot.findUnique = vi.fn(({ where: { id }, include }) => {
      const slot = db.slots[id];
      if (!slot) return null;
      const signups = db.signups.filter((s) => s.slotId === id);
      const result = { ...slot, signups };
      if (include?.member) result.member = slot.member;
      return result;
    });

    prisma.meetingSignup.create = vi.fn(({ data }) => {
      const existing = db.signups.find(
        (s) => s.slotId === data.slotId && s.email === data.email
      );
      if (existing) {
        const err = new Error('Unique constraint');
        err.code = 'P2002';
        throw err;
      }
      const signup = {
        id: `signup-${db.signups.length + 1}`,
        ...data,
        attended: false,
        createdAt: new Date(),
      };
      db.signups.push(signup);
      return signup;
    });

    return db;
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates a signup when the slot has capacity', async () => {
    buildFakeDb();

    const result = await createMeetingSignup({
      slotId: 'slot-1',
      fullName: 'Candidate',
      email: 'candidate@example.com',
      studentId: '123456789',
    });

    expect(result.signup.slotId).toBe('slot-1');
    expect(result.signup.email).toBe('candidate@example.com');
    expect(result.slot.id).toBe('slot-1');
  });

  it('throws a conflict when the slot is full', async () => {
    const db = buildFakeDb({ slots: { 'slot-1': makeSlot({ capacity: 1 }) } });
    db.signups.push({ id: 'signup-existing', slotId: 'slot-1', email: 'other@example.com', fullName: 'Other', studentId: '111' });

    await expect(
      createMeetingSignup({
        slotId: 'slot-1',
        fullName: 'Candidate',
        email: 'candidate@example.com',
        studentId: '123456789',
      })
    ).rejects.toThrow(MeetingBookingConflictError);
  });

  it('throws a conflict when the candidate already has a slot in the active cycle', async () => {
    const db = buildFakeDb();
    db.signups.push({ id: 'signup-existing', slotId: 'slot-1', email: 'candidate@example.com', fullName: 'Candidate', studentId: '123456789' });

    await expect(
      createMeetingSignup({
        slotId: 'slot-1',
        fullName: 'Candidate',
        email: 'candidate@example.com',
        studentId: '123456789',
      })
    ).rejects.toThrow(MeetingBookingConflictError);
  });

  it('allows only one of two concurrent signups for the last seat', async () => {
    buildFakeDb({ slots: { 'slot-1': makeSlot({ capacity: 1 }) } });

    const first = createMeetingSignup({
      slotId: 'slot-1',
      fullName: 'Candidate One',
      email: 'one@example.com',
      studentId: '111',
    });
    const second = createMeetingSignup({
      slotId: 'slot-1',
      fullName: 'Candidate Two',
      email: 'two@example.com',
      studentId: '222',
    });

    const [a, b] = await Promise.allSettled([first, second]);

    const successes = [a, b].filter((r) => r.status === 'fulfilled');
    const failures = [a, b].filter((r) => r.status === 'rejected');

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBeInstanceOf(MeetingBookingConflictError);
    expect(failures[0].reason.message).toMatch(/full/i);
  });

  it('allows only one of two concurrent signups across different cycle slots from the same candidate', async () => {
    buildFakeDb({
      slots: {
        'slot-1': makeSlot({ id: 'slot-1', startTime: new Date('2026-08-01T17:00:00.000Z') }),
        'slot-2': makeSlot({ id: 'slot-2', startTime: new Date('2026-08-02T17:00:00.000Z') }),
      },
    });

    const first = createMeetingSignup({
      slotId: 'slot-1',
      fullName: 'Candidate',
      email: 'candidate@example.com',
      studentId: '123456789',
    });
    const second = createMeetingSignup({
      slotId: 'slot-2',
      fullName: 'Candidate',
      email: 'candidate@example.com',
      studentId: '123456789',
    });

    const [a, b] = await Promise.allSettled([first, second]);

    const successes = [a, b].filter((r) => r.status === 'fulfilled');
    const failures = [a, b].filter((r) => r.status === 'rejected');

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBeInstanceOf(MeetingBookingConflictError);
    expect(failures[0].reason.message).toMatch(/already signed up/i);
  });
});
