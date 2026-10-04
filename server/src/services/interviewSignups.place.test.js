// placeCandidate looks for an existing seat across the whole round, not just the
// interview it is placing into. A coffee chat round is several interviews - the
// morning block, the afternoon block, any virtual chats - and one seat per
// candidate has to hold across all of them.
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../prismaClient.js', () => {
  const tx = {
    $queryRaw: vi.fn(async () => []),
    interviewSlot: { findUnique: vi.fn() },
    interviewSlotSignup: { findMany: vi.fn(), count: vi.fn(), create: vi.fn() },
  };
  return { default: { __tx: tx, $transaction: vi.fn((fn) => fn(tx)) } };
});

const prisma = (await import('../prismaClient.js')).default;
const tx = prisma.__tx;
const { placeCandidate } = await import('./interviewSignups.js');

const virtualSlot = {
  id: 'slot-v',
  interviewId: 'chat-1',
  candidateCapacity: null,
  interview: { id: 'chat-1', cycleId: 'c1', interviewType: 'COFFEE_CHAT', status: 'UPCOMING' },
};

beforeEach(() => {
  vi.clearAllMocks();
  tx.interviewSlot.findUnique.mockResolvedValue(virtualSlot);
});

describe('placeCandidate', () => {
  it('searches the round for an existing seat, not just this interview', async () => {
    tx.interviewSlotSignup.findMany.mockResolvedValue([]);
    tx.interviewSlotSignup.count.mockResolvedValue(0);
    tx.interviewSlotSignup.create.mockResolvedValue({ id: 'su-new' });

    await placeCandidate({ interviewId: 'chat-1', slotId: 'slot-v', applicationId: 'a1', actorId: 'admin-1', force: true });

    const { where } = tx.interviewSlotSignup.findMany.mock.calls[0][0];
    expect(where).not.toHaveProperty('interviewId');
    expect(where.slot.interview).toMatchObject({ cycleId: 'c1', interviewType: 'COFFEE_CHAT' });
  });

  it('moves somebody holding an in-person seat instead of giving them a second one', async () => {
    tx.interviewSlotSignup.findMany.mockResolvedValue([
      { id: 'su-am', slotId: 'slot-am', interviewId: 'morning', status: 'CONFIRMED' },
    ]);

    const result = await placeCandidate({ interviewId: 'chat-1', slotId: 'slot-v', applicationId: 'a1', actorId: 'admin-1' });

    expect(result).toEqual({ placed: null, moveInstead: 'su-am' });
    expect(tx.interviewSlotSignup.create).not.toHaveBeenCalled();
  });

  it('moves the waitlist entry, so its later promotion cannot pull them back out', async () => {
    tx.interviewSlotSignup.findMany.mockResolvedValue([
      { id: 'su-held', slotId: 'slot-pm', interviewId: 'afternoon', status: 'CONFIRMED' },
      { id: 'su-wait', slotId: 'slot-am', interviewId: 'morning', status: 'WAITLISTED', heldSeatId: 'su-held' },
    ]);

    const result = await placeCandidate({ interviewId: 'chat-1', slotId: 'slot-v', applicationId: 'a1', actorId: 'admin-1' });

    expect(result.moveInstead).toBe('su-wait');
  });

  it('refuses a cancelled interview, so a placement racing its cancellation finds nothing to join', async () => {
    tx.interviewSlot.findUnique.mockResolvedValue({ ...virtualSlot, interview: { ...virtualSlot.interview, status: 'CANCELLED' } });
    await expect(
      placeCandidate({ interviewId: 'chat-1', slotId: 'slot-v', applicationId: 'a1', actorId: 'admin-1', force: true })
    ).rejects.toMatchObject({ status: 409 });
    expect(tx.interviewSlotSignup.create).not.toHaveBeenCalled();
  });
});

describe('moveSignup', () => {
  it('reports who was promoted into the seat a waitlisted candidate gives up', async () => {
    // Ada waits for the morning while holding an afternoon seat. Moving her
    // into a virtual chat releases the afternoon seat, and Ben, waiting for
    // the afternoon, is promoted into it. He is owed an email, so he has to be
    // in what moveSignup returns.
    const ada = {
      id: 'su-ada',
      slotId: 'slot-am',
      interviewId: 'morning',
      applicationId: 'a-ada',
      status: 'WAITLISTED',
      heldSeatId: 'su-ada-pm',
      slot: { id: 'slot-am', startTime: new Date('2030-01-01T17:00:00Z') },
    };
    const ben = {
      id: 'su-ben',
      slotId: 'slot-pm',
      interviewId: 'morning',
      applicationId: 'a-ben',
      status: 'WAITLISTED',
      waitlistedAt: new Date('2029-12-01T00:00:00Z'),
      heldSeatId: null,
    };
    tx.interview = { findUnique: vi.fn().mockResolvedValue({ cycleId: 'c1', interviewType: 'COFFEE_CHAT' }) };
    tx.interviewSlotSignup.findUnique = vi.fn().mockResolvedValue(ada);
    tx.interviewSlotSignup.update = vi.fn(async ({ where }) =>
      where.id === 'su-ada-pm' ? { id: 'su-ada-pm', slotId: 'slot-pm' } : { id: where.id }
    );
    tx.interviewSlotSignup.updateMany = vi.fn().mockResolvedValue({ count: 1 });
    tx.interviewSlot.findUnique.mockImplementation(async ({ where }) => {
      if (where.id === 'slot-v') return virtualSlot;
      if (where.id === 'slot-pm') return { id: 'slot-pm', candidateCapacity: 1, interviewId: 'morning' };
      return { id: 'slot-am', candidateCapacity: 2, interviewId: 'morning' };
    });
    // Afternoon has room once Ada's seat is released, then is full again.
    let pmCounts = 0;
    tx.interviewSlotSignup.count.mockImplementation(async ({ where }) => {
      if (where.slotId === 'slot-pm') return pmCounts++ === 0 ? 0 : 1;
      if (where.slotId === 'slot-am') return 2;
      return 0;
    });
    tx.interviewSlotSignup.findMany.mockImplementation(async ({ where }) => (where.slotId === 'slot-pm' ? [ben] : []));

    const { moveSignup } = await import('./interviewSignups.js');
    const result = await moveSignup({ signupId: 'su-ada', toSlotId: 'slot-v', actorId: 'admin-1', isAdmin: true, force: true });

    expect(result.promotions.map((p) => p.signupId)).toEqual(['su-ben']);
  });
});

describe('closeInterviewToBookings', () => {
  const load = async () => (await import('./interviewSignups.js')).closeInterviewToBookings;

  it('cancels an open interview and returns its live seats', async () => {
    tx.interview = { findUnique: vi.fn().mockResolvedValue({ status: 'UPCOMING' }), update: vi.fn() };
    tx.interviewSlotSignup.findMany.mockResolvedValue([{ id: 'su-1' }]);

    expect(await (await load())({ interviewId: 'chat-1', slotId: 'slot-v' })).toEqual([{ id: 'su-1' }]);
    expect(tx.interview.update).toHaveBeenCalledWith({ where: { id: 'chat-1' }, data: { status: 'CANCELLED' } });
  });

  it('on an already-cancelled interview returns what is still booked, so a stalled cancel can finish', async () => {
    tx.interview = { findUnique: vi.fn().mockResolvedValue({ status: 'CANCELLED' }), update: vi.fn() };
    tx.interviewSlotSignup.findMany.mockResolvedValue([{ id: 'su-left' }]);

    expect(await (await load())({ interviewId: 'chat-1', slotId: 'slot-v' })).toEqual([{ id: 'su-left' }]);
    expect(tx.interview.update).not.toHaveBeenCalled();
  });

  it('leaves a completed interview alone', async () => {
    tx.interview = { findUnique: vi.fn().mockResolvedValue({ status: 'COMPLETED' }), update: vi.fn() };

    expect(await (await load())({ interviewId: 'chat-1', slotId: 'slot-v' })).toBeNull();
    expect(tx.interview.update).not.toHaveBeenCalled();
  });
});
