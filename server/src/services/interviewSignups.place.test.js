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
});
