import { describe, it, expect } from 'vitest';
import {
  MAX_CASCADE,
  chooseFallbackSlot,
  hasRoom,
  isCandidateBookable,
  nextInLine,
  planPromotions,
  seatsRemaining,
} from './interviewSignupPolicy.js';

const slot = (over = {}) => ({
  id: 's1',
  startTime: '2026-10-01T09:00:00Z',
  candidateCapacity: 4,
  confirmedCount: 0,
  ...over,
});

describe('isCandidateBookable', () => {
  it('separates "not self-service" from "self-service and full"', () => {
    // Null capacity is an interviewer-only sitting; zero is a full one. The
    // difference decides whether a candidate sees the slot at all.
    expect(isCandidateBookable(slot({ candidateCapacity: null }))).toBe(false);
    expect(isCandidateBookable(slot({ candidateCapacity: 0 }))).toBe(true);
    expect(hasRoom(slot({ candidateCapacity: 0 }), 0)).toBe(false);
  });

  it('respects the signup window at both ends', () => {
    const now = new Date('2026-10-01T12:00:00Z');
    expect(isCandidateBookable(slot({ signupOpensAt: '2026-10-02T00:00:00Z' }), now)).toBe(false);
    expect(isCandidateBookable(slot({ signupClosesAt: '2026-09-30T00:00:00Z' }), now)).toBe(false);
    expect(isCandidateBookable(slot({ signupOpensAt: '2026-09-01T00:00:00Z' }), now)).toBe(true);
  });

  it('reports remaining seats, and nothing for a non-bookable slot', () => {
    expect(seatsRemaining(slot({ candidateCapacity: 4 }), 3)).toBe(1);
    expect(seatsRemaining(slot({ candidateCapacity: null }), 3)).toBeNull();
  });
});

describe('chooseFallbackSlot', () => {
  const slots = [
    slot({ id: 'morning', startTime: '2026-10-01T09:00:00Z', candidateCapacity: 2, confirmedCount: 2 }),
    slot({ id: 'afternoon', startTime: '2026-10-01T14:00:00Z', candidateCapacity: 2, confirmedCount: 0 }),
  ];

  it('parks the candidate in the other block when theirs is full', () => {
    expect(chooseFallbackSlot(slots, 'morning').id).toBe('afternoon');
  });

  it('never offers the slot they already asked for', () => {
    const bothOpen = [slot({ id: 'a', confirmedCount: 0 }), slot({ id: 'b', startTime: '2026-10-01T14:00:00Z', confirmedCount: 0 })];
    expect(chooseFallbackSlot(bothOpen, 'a').id).toBe('b');
  });

  it('returns null when every other slot is full', () => {
    const allFull = slots.map((s) => ({ ...s, confirmedCount: s.candidateCapacity }));
    expect(chooseFallbackSlot(allFull, 'morning')).toBeNull();
  });

  it('skips slots that are not open to self-signup', () => {
    const withPrivate = [
      slot({ id: 'morning', candidateCapacity: 2, confirmedCount: 2 }),
      slot({ id: 'private', startTime: '2026-10-01T10:00:00Z', candidateCapacity: null }),
      slot({ id: 'afternoon', startTime: '2026-10-01T14:00:00Z', candidateCapacity: 2, confirmedCount: 0 }),
    ];
    expect(chooseFallbackSlot(withPrivate, 'morning').id).toBe('afternoon');
  });

  it('picks the earliest, and breaks ties deterministically', () => {
    const sameTime = [
      slot({ id: 'zulu', startTime: '2026-10-01T14:00:00Z' }),
      slot({ id: 'alpha', startTime: '2026-10-01T14:00:00Z' }),
    ];
    expect(chooseFallbackSlot(sameTime, 'other').id).toBe('alpha');
  });
});

describe('nextInLine', () => {
  it('gives a freed seat to someone with no seat before someone upgrading', () => {
    // The fairness call: a waitlisted candidate already holds a fallback seat,
    // a NEEDS_PLACEMENT candidate holds nothing at all.
    const head = nextInLine([
      { id: 'waiting', status: 'WAITLISTED', waitlistedAt: '2026-09-01T00:00:00Z' },
      { id: 'unplaced', status: 'NEEDS_PLACEMENT', signedUpAt: '2026-09-02T00:00:00Z' },
    ]);
    expect(head.id).toBe('unplaced');
  });

  it('orders within a tier by when they joined', () => {
    const head = nextInLine([
      { id: 'later', status: 'WAITLISTED', waitlistedAt: '2026-09-05T00:00:00Z' },
      { id: 'earlier', status: 'WAITLISTED', waitlistedAt: '2026-09-01T00:00:00Z' },
    ]);
    expect(head.id).toBe('earlier');
  });

  it('breaks same-instant ties by id rather than insertion order', () => {
    const at = '2026-09-01T00:00:00Z';
    const entries = [
      { id: 'zulu', status: 'WAITLISTED', waitlistedAt: at },
      { id: 'alpha', status: 'WAITLISTED', waitlistedAt: at },
    ];
    expect(nextInLine(entries).id).toBe('alpha');
    expect(nextInLine([...entries].reverse()).id).toBe('alpha');
  });

  it('ignores rows that are history, not a queue', () => {
    expect(nextInLine([{ id: 'x', status: 'CANCELLED' }, { id: 'y', status: 'RELEASED' }])).toBeNull();
    expect(nextInLine([])).toBeNull();
  });
});

describe('planPromotions', () => {
  const snapshotOf = (slots) => new Map(Object.entries(slots));

  it('promotes nobody when the slot is still full', () => {
    const snap = snapshotOf({
      a: { capacity: 2, confirmed: 2, queue: [{ id: 'w', status: 'WAITLISTED', waitlistedAt: '2026-09-01' }] },
    });
    expect(planPromotions(snap, 'a')).toEqual([]);
  });

  it('releases the held seat before applying the promotion', () => {
    // Order is not cosmetic: between the two, the candidate would hold two
    // confirmed seats in one interview, which the partial unique index forbids.
    const snap = snapshotOf({
      morning: {
        capacity: 2,
        confirmed: 1,
        queue: [{ id: 'w1', status: 'WAITLISTED', applicationId: 'app1', waitlistedAt: '2026-09-01', heldSeatId: 'seat1', heldSeatSlotId: 'afternoon' }],
      },
      afternoon: { capacity: 2, confirmed: 1, queue: [] },
    });
    const ops = planPromotions(snap, 'morning');
    expect(ops.map((o) => o.type)).toEqual(['RELEASE', 'PROMOTE']);
    expect(ops[0]).toMatchObject({ signupId: 'seat1', slotId: 'afternoon' });
    expect(ops[1]).toMatchObject({ signupId: 'w1', slotId: 'morning' });
  });

  it('cascades: a released seat frees room for that slot\'s own waitlist', () => {
    const snap = snapshotOf({
      morning: {
        capacity: 2,
        confirmed: 1,
        queue: [{ id: 'w1', status: 'WAITLISTED', applicationId: 'a1', waitlistedAt: '2026-09-01', heldSeatId: 'seat1', heldSeatSlotId: 'afternoon' }],
      },
      afternoon: {
        capacity: 1,
        confirmed: 1,
        queue: [{ id: 'w2', status: 'NEEDS_PLACEMENT', applicationId: 'a2', signedUpAt: '2026-09-02' }],
      },
    });
    const ops = planPromotions(snap, 'morning');
    // w1 promoted into morning, its afternoon seat released, and w2 - who had
    // no seat at all - takes the afternoon seat that just opened.
    expect(ops).toEqual([
      { type: 'RELEASE', signupId: 'seat1', slotId: 'afternoon' },
      { type: 'PROMOTE', signupId: 'w1', slotId: 'morning', applicationId: 'a1', fromStatus: 'WAITLISTED' },
      { type: 'PROMOTE', signupId: 'w2', slotId: 'afternoon', applicationId: 'a2', fromStatus: 'NEEDS_PLACEMENT' },
    ]);
  });

  it('fills every open seat, not just one', () => {
    const snap = snapshotOf({
      a: {
        capacity: 3,
        confirmed: 0,
        queue: [
          { id: 'w1', status: 'WAITLISTED', applicationId: 'a1', waitlistedAt: '2026-09-01' },
          { id: 'w2', status: 'WAITLISTED', applicationId: 'a2', waitlistedAt: '2026-09-02' },
        ],
      },
    });
    expect(planPromotions(snap, 'a').map((o) => o.signupId)).toEqual(['w1', 'w2']);
  });

  it('stops at the cascade bound rather than looping forever', () => {
    const queue = Array.from({ length: 10 }, (_, i) => ({
      id: `w${i}`,
      status: 'WAITLISTED',
      applicationId: `a${i}`,
      waitlistedAt: `2026-09-0${i % 9}`,
    }));
    const snap = snapshotOf({ a: { capacity: 100, confirmed: 0, queue } });
    expect(planPromotions(snap, 'a', { maxCascade: 3 })).toHaveLength(3);
    expect(MAX_CASCADE).toBeGreaterThan(0);
  });

  it('does nothing for a slot with no capacity configured', () => {
    const snap = snapshotOf({
      a: { capacity: null, confirmed: 0, queue: [{ id: 'w', status: 'WAITLISTED', waitlistedAt: '2026-09-01' }] },
    });
    expect(planPromotions(snap, 'a')).toEqual([]);
  });
});
