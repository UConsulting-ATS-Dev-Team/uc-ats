// What the guests panel and the event list count as waiting for an admin.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../prismaClient.js', () => ({ default: {} }));
const { holdsFor } = await import('./heldGuests.js');

describe('holdsFor', () => {
  it('does not hold a guest just for having no profile yet', () => {
    expect(holdsFor({ matchStatus: 'UNMATCHED', matchNote: 'no UID answer; no candidate', approvalStatus: 'approved' }))
      .toEqual([]);
  });

  it('still holds an unmatched guest whose status it cannot read', () => {
    expect(holdsFor({ matchStatus: 'UNMATCHED', matchNote: 'no UID answer', approvalStatus: 'session' }))
      .toEqual(['unknownStatus']);
  });

  it('flags a match made on the UID alone', () => {
    expect(holdsFor({ matchStatus: 'MATCHED_CANDIDATE', matchNote: 'matched on the UID alone', approvalStatus: 'approved' }))
      .toEqual(['flagged']);
  });
});
