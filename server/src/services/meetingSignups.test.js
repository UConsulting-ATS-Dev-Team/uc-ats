import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { bookMeetingSlot, moveMeetingSignup, cancelOwnMeetingSignup, BookingError } from './meetingSignups.js';

// The transaction body runs against the same mocks, and every raw query is
// recorded so tests can assert the locks are taken before anything is read.
vi.mock('../prismaClient.js', () => {
  const calls = [];
  const tx = {
    calls,
    $queryRaw: vi.fn((strings, ...values) => {
      calls.push(strings.join('?'));
      return Promise.resolve([{ locked: 1 }]);
    }),
    meetingSignup: { findMany: vi.fn(), findUnique: vi.fn(), count: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    meetingSlot: { findUnique: vi.fn() },
    recruitingCycle: { findFirst: vi.fn() },
  };
  return { default: { ...tx, $transaction: vi.fn((fn) => fn(tx)) } };
});

vi.mock('./activeCycle.js', () => ({
  resolveCandidateCycle: vi.fn().mockResolvedValue({
    id: 'fall-2026',
    startDate: new Date('2026-09-01T00:00:00Z'),
    endDate: new Date('2027-06-30T00:00:00Z'),
  }),
}));

const future = (days) => new Date(Date.now() + days * 24 * 60 * 60 * 1000);

const slot = (overrides = {}) => ({
  id: 'slot-b',
  capacity: 2,
  location: 'Kerckhoff Patio',
  startTime: future(5),
  endTime: null,
  member: { id: 'host-1', fullName: 'Avery Chen', email: 'avery@ucla.edu' },
  ...overrides,
});

const account = { fullName: 'Jordan Rivera', email: 'jordan@ucla.edu', studentId: '123456789' };

beforeEach(() => {
  vi.clearAllMocks();
  prisma.calls.length = 0;
  prisma.meetingSignup.findMany.mockResolvedValue([]);
  prisma.meetingSignup.count.mockResolvedValue(0);
  prisma.meetingSlot.findUnique.mockResolvedValue(slot());
  prisma.meetingSignup.create.mockImplementation(({ data }) => Promise.resolve({ id: 'signup-new', ...data }));
  prisma.meetingSignup.update.mockImplementation(({ where, data }) => Promise.resolve({ id: where.id, ...account, ...data }));
});

const rejection = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected a rejection');
};

describe('bookMeetingSlot', () => {
  it('refuses a second booking in the same cycle, however the address is cased', async () => {
    prisma.meetingSignup.findMany.mockResolvedValue([{ id: 'signup-old', slot: { startTime: future(3) } }]);

    const error = await rejection(bookMeetingSlot({ slotId: 'slot-b', ...account, email: 'Jordan@UCLA.edu' }));

    expect(error).toBeInstanceOf(BookingError);
    expect(error.status).toBe(409);
    expect(error.code).toBe('ALREADY_BOOKED');
    expect(prisma.meetingSignup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { email: { equals: 'Jordan@UCLA.edu', mode: 'insensitive' } } })
    );
    expect(prisma.meetingSignup.create).not.toHaveBeenCalled();
  });

  it('allows a booking when the earlier one was in a different cycle', async () => {
    prisma.meetingSignup.findMany.mockResolvedValue([{ id: 'signup-2025', slot: { startTime: new Date('2025-10-01T00:00:00Z') } }]);

    const { signup } = await bookMeetingSlot({ slotId: 'slot-b', ...account });
    expect(signup.id).toBe('signup-new');
  });

  it('locks the candidate, then the slot, before reading anything', async () => {
    await bookMeetingSlot({ slotId: 'slot-b', ...account });

    expect(prisma.calls[0]).toContain('pg_advisory_xact_lock');
    expect(prisma.calls[1]).toContain('FOR UPDATE');
    // The candidate lock is taken before the one-per-cycle read.
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.meetingSignup.findMany.mock.invocationCallOrder[0]
    );
    // The slot lock is taken before the capacity count.
    expect(prisma.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      prisma.meetingSignup.count.mock.invocationCallOrder[0]
    );
  });

  it('refuses a full slot', async () => {
    prisma.meetingSignup.count.mockResolvedValue(2);
    const error = await rejection(bookMeetingSlot({ slotId: 'slot-b', ...account }));
    expect(error.status).toBe(409);
    expect(error.code).toBe('SLOT_FULL');
  });

  it('refuses a slot that has already started', async () => {
    prisma.meetingSlot.findUnique.mockResolvedValue(slot({ startTime: future(-1) }));
    const error = await rejection(bookMeetingSlot({ slotId: 'slot-b', ...account }));
    expect(error.status).toBe(400);
  });

  it('refuses a slot outside the cycle, which the one-per-cycle rule could not see', async () => {
    prisma.meetingSlot.findUnique.mockResolvedValue(slot({ startTime: new Date('2027-09-01T00:00:00Z') }));
    const error = await rejection(bookMeetingSlot({ slotId: 'slot-b', ...account }));
    expect(error.status).toBe(400);
  });
});

describe('moveMeetingSignup', () => {
  const current = (overrides = {}) => ({
    id: 'signup-1',
    slotId: 'slot-a',
    email: 'Jordan@ucla.edu',
    slot: slot({ id: 'slot-a', startTime: future(3) }),
    ...overrides,
  });

  it('moves the booking, keeping the signup', async () => {
    prisma.meetingSignup.findUnique.mockResolvedValue(current());

    const { signup, from, to } = await moveMeetingSignup({ signupId: 'signup-1', slotId: 'slot-b', account });

    expect(prisma.meetingSignup.update).toHaveBeenCalledWith({ where: { id: 'signup-1' }, data: { slotId: 'slot-b' } });
    expect(signup.id).toBe('signup-1');
    expect(from.id).toBe('slot-a');
    expect(to.id).toBe('slot-b');
  });

  it("refuses someone else's booking", async () => {
    prisma.meetingSignup.findUnique.mockResolvedValue(current({ email: 'someone@ucla.edu' }));
    const error = await rejection(moveMeetingSignup({ signupId: 'signup-1', slotId: 'slot-b', account }));
    expect(error.status).toBe(403);
    expect(prisma.meetingSignup.update).not.toHaveBeenCalled();
  });

  it('refuses inside the 12-hour cutoff', async () => {
    prisma.meetingSignup.findUnique.mockResolvedValue(current({ slot: slot({ id: 'slot-a', startTime: future(0.25) }) }));
    const error = await rejection(moveMeetingSignup({ signupId: 'signup-1', slotId: 'slot-b', account }));
    expect(error.status).toBe(400);
    expect(error.code).toBe('CUTOFF');
  });

  it('leaves them where they were when the new slot is full', async () => {
    prisma.meetingSignup.findUnique.mockResolvedValue(current());
    prisma.meetingSignup.count.mockResolvedValue(2);

    const error = await rejection(moveMeetingSignup({ signupId: 'signup-1', slotId: 'slot-b', account }));

    expect(error.code).toBe('SLOT_FULL');
    expect(prisma.meetingSignup.update).not.toHaveBeenCalled();
  });

  it('refuses a move to the slot they already hold', async () => {
    prisma.meetingSignup.findUnique.mockResolvedValue(current({ slotId: 'slot-b' }));
    const error = await rejection(moveMeetingSignup({ signupId: 'signup-1', slotId: 'slot-b', account }));
    expect(error.status).toBe(400);
  });

  it('will not move an old-cycle booking in beside the one they hold this cycle', async () => {
    // Their old booking is still modifiable, and they already hold one this cycle.
    prisma.meetingSignup.findUnique.mockResolvedValue(current());
    prisma.meetingSignup.findMany.mockResolvedValue([{ id: 'signup-this-cycle', slot: { startTime: future(4) } }]);

    const error = await rejection(moveMeetingSignup({ signupId: 'signup-1', slotId: 'slot-b', account }));

    expect(error.code).toBe('ALREADY_BOOKED');
    expect(prisma.meetingSignup.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: { not: 'signup-1' } }) })
    );
    expect(prisma.meetingSignup.update).not.toHaveBeenCalled();
  });
});

describe('cancelOwnMeetingSignup', () => {
  const booking = (overrides = {}) => ({
    id: 'signup-1',
    slotId: 'slot-a',
    email: 'Jordan@ucla.edu',
    slot: slot({ id: 'slot-a', startTime: future(3) }),
    ...overrides,
  });

  it('takes the candidate lock before reading the booking, so it cannot race a move', async () => {
    prisma.meetingSignup.findUnique.mockResolvedValue(booking());

    const cancelled = await cancelOwnMeetingSignup({ signupId: 'signup-1', account });

    expect(prisma.calls[0]).toContain('pg_advisory_xact_lock');
    expect(prisma.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.meetingSignup.findUnique.mock.invocationCallOrder[0]
    );
    expect(prisma.meetingSignup.delete).toHaveBeenCalledWith({ where: { id: 'signup-1' } });
    expect(cancelled.slot.id).toBe('slot-a');
  });

  it("refuses someone else's booking", async () => {
    prisma.meetingSignup.findUnique.mockResolvedValue(booking({ email: 'someone@ucla.edu' }));
    const error = await rejection(cancelOwnMeetingSignup({ signupId: 'signup-1', account }));
    expect(error.status).toBe(403);
    expect(prisma.meetingSignup.delete).not.toHaveBeenCalled();
  });

  it('refuses inside the 12-hour cutoff', async () => {
    prisma.meetingSignup.findUnique.mockResolvedValue(booking({ slot: slot({ id: 'slot-a', startTime: future(0.25) }) }));
    const error = await rejection(cancelOwnMeetingSignup({ signupId: 'signup-1', account }));
    expect(error.code).toBe('CUTOFF');
    expect(prisma.meetingSignup.delete).not.toHaveBeenCalled();
  });
});
