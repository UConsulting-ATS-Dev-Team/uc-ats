import { describe, it, expect, vi } from 'vitest';
import { checkCanBookSlot } from './candidateSchedulingView.js';

// A slot belonging to a first-round interview in the active cycle.
const firstRoundSlot = {
  id: 's1',
  interview: { cycleId: 'c1', interviewType: 'ROUND_ONE', status: 'UPCOMING' },
};

const clientReturning = (slot) => ({
  interviewSlot: { findUnique: vi.fn().mockResolvedValue(slot) },
});

describe('checkCanBookSlot', () => {
  it('lets a candidate book the round they are actually in', async () => {
    const denied = await checkCanBookSlot(
      { id: 'a1', status: 'UNDER_REVIEW', currentRound: 3 },
      's1',
      'c1',
      clientReturning(firstRoundSlot)
    );
    expect(denied).toBeNull();
  });

  it('refuses a round the candidate has not advanced to', async () => {
    // The page never offers this, but slotId arrives in the request body - so a
    // coffee chat candidate posting a first-round slot id has to be stopped
    // here or they appear in an interviewer's roster for a round they were
    // never advanced to.
    const denied = await checkCanBookSlot(
      { id: 'a2', status: 'UNDER_REVIEW', currentRound: 2 },
      's1',
      'c1',
      clientReturning(firstRoundSlot)
    );
    expect(denied).toMatchObject({ status: 403 });
    expect(denied.error).toMatch(/have not advanced to/);
  });

  it('refuses a rejected candidate before looking anything up', async () => {
    const client = clientReturning(firstRoundSlot);
    const denied = await checkCanBookSlot(
      { id: 'a3', status: 'REJECTED', currentRound: 3 },
      's1',
      'c1',
      client
    );
    expect(denied).toMatchObject({ status: 403 });
    expect(client.interviewSlot.findUnique).not.toHaveBeenCalled();
  });

  it('refuses a slot from another cycle without confirming it exists', async () => {
    const denied = await checkCanBookSlot(
      { id: 'a4', status: 'UNDER_REVIEW', currentRound: 3 },
      's1',
      'c2',
      clientReturning(firstRoundSlot)
    );
    expect(denied).toMatchObject({ status: 403 });
    // Deliberately the same wording as any other refusal - a precise message
    // would confirm the slot is real.
    expect(denied.error).not.toMatch(/round/);
  });

  it('refuses a slot whose interview is finished', async () => {
    const denied = await checkCanBookSlot(
      { id: 'a5', status: 'UNDER_REVIEW', currentRound: 3 },
      's1',
      'c1',
      clientReturning({ ...firstRoundSlot, interview: { ...firstRoundSlot.interview, status: 'COMPLETED' } })
    );
    expect(denied).toMatchObject({ status: 409 });
  });

  it('refuses a slot that no longer exists', async () => {
    const denied = await checkCanBookSlot(
      { id: 'a6', status: 'UNDER_REVIEW', currentRound: 3 },
      'gone',
      'c1',
      clientReturning(null)
    );
    expect(denied).toMatchObject({ status: 404 });
  });

  it('refuses a candidate in a round that schedules nothing', async () => {
    // Document review and accepted both map to no interview type at all.
    const denied = await checkCanBookSlot(
      { id: 'a7', status: 'UNDER_REVIEW', currentRound: 1 },
      's1',
      'c1',
      clientReturning(firstRoundSlot)
    );
    expect(denied).toMatchObject({ status: 403 });
  });
});
