// The roster is read at send time, so it has to be gated at send time.
//
// A notification row outlives the assignment that produced it. FAILED,
// SUPPRESSED and stalled rows all stay resendable, and SUPPRESSED exists to be
// sent later once scheduling email is switched on. Resending an old
// INTERVIEWER_ASSIGNED must not hand the session's current candidate list to
// somebody who has since been taken off it.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { loadCandidateRoster } from './interviewSlotComms.js';

const signups = [
  { groupLabel: null, application: { firstName: 'Ada', lastName: 'Lovelace' } },
  { groupLabel: null, application: { firstName: 'Grace', lastName: 'Hopper' } },
];

let client;

beforeEach(() => {
  client = {
    interviewSlotAssignment: { findFirst: vi.fn().mockResolvedValue({ id: 'asn-1' }) },
    interviewSlotSignup: { findMany: vi.fn().mockResolvedValue(signups) },
  };
});

const assigned = (overrides = {}) => ({
  type: 'INTERVIEWER_ASSIGNED',
  recipient: 'member@ucla.edu',
  slotId: 'slot-1',
  ...overrides,
});

describe('loadCandidateRoster', () => {
  it('gives the roster to somebody still on the session', async () => {
    await expect(loadCandidateRoster(assigned(), client)).resolves.toEqual(signups);
  });

  it('gives nothing to somebody taken off it', async () => {
    client.interviewSlotAssignment.findFirst.mockResolvedValue(null);

    await expect(loadCandidateRoster(assigned(), client)).resolves.toEqual([]);
    // And does not even read the candidates.
    expect(client.interviewSlotSignup.findMany).not.toHaveBeenCalled();
  });

  it('only counts an assignment that has not been removed', async () => {
    await loadCandidateRoster(assigned(), client);

    expect(client.interviewSlotAssignment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ slotId: 'slot-1', removedAt: null }),
      })
    );
  });

  it('matches the address case-insensitively', async () => {
    // Stored lowercased now, but a recipient recorded before that was enforced
    // need not be, and a former interviewer must not slip through on casing.
    await loadCandidateRoster(assigned({ recipient: 'Member@UCLA.edu' }), client);

    const [{ where }] = client.interviewSlotAssignment.findFirst.mock.calls[0];
    expect(where.user.email).toEqual({ equals: 'Member@UCLA.edu', mode: 'insensitive' });
  });

  it('reads nothing at all for a candidate notification', async () => {
    await expect(loadCandidateRoster({ ...assigned(), type: 'CONFIRMATION' }, client)).resolves.toEqual([]);
    expect(client.interviewSlotAssignment.findFirst).not.toHaveBeenCalled();
  });

  it('treats a failed lookup as no roster rather than sending one anyway', async () => {
    client.interviewSlotAssignment.findFirst.mockRejectedValue(new Error('connection lost'));

    await expect(loadCandidateRoster(assigned(), client)).resolves.toEqual([]);
  });

  it('needs both a session and a recipient', async () => {
    await expect(loadCandidateRoster(assigned({ slotId: null }), client)).resolves.toEqual([]);
    await expect(loadCandidateRoster(assigned({ recipient: null }), client)).resolves.toEqual([]);
  });
});
