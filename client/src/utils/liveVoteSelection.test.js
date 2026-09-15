import { describe, it, expect } from 'vitest';
import {
  ballotTone,
  filterBySearch,
  formatBallotLine,
  idsWithDecision,
  latestBallot,
  sortForSession
} from './liveVoteSelection';

const people = [
  { id: 'a', firstName: 'Zoe', lastName: 'Park', email: 'zoe@ucla.edu', major: 'Economics' },
  { id: 'b', firstName: 'Adam', lastName: 'Lee', email: 'adam@ucla.edu', major: 'History' },
  { id: 'c', firstName: 'Mia', lastName: 'Chen', email: 'mia@ucla.edu', major: 'Economics', locked: true },
  { id: 'd', firstName: 'Ben', lastName: 'Ross', email: 'ben@ucla.edu', major: 'Math' }
];
const decisions = { a: 'maybe_no', b: 'yes', c: 'maybe_yes', d: 'maybe_yes' };

describe('filterBySearch', () => {
  it('matches name, email and major, ignoring case', () => {
    expect(filterBySearch(people, 'zoe park').map((p) => p.id)).toEqual(['a']);
    expect(filterBySearch(people, 'ADAM@').map((p) => p.id)).toEqual(['b']);
    expect(filterBySearch(people, 'econ').map((p) => p.id)).toEqual(['a', 'c']);
  });

  it('returns everyone for a blank query', () => {
    expect(filterBySearch(people, '  ')).toBe(people);
  });
});

describe('sortForSession', () => {
  it('puts maybes first, then settled decisions, then undecided, by name within each', () => {
    const withPending = [...people, { id: 'e', firstName: 'Al', lastName: 'Undecided' }];
    expect(sortForSession(withPending, decisions).map((p) => p.id)).toEqual(['d', 'c', 'a', 'b', 'e']);
  });
});

describe('idsWithDecision', () => {
  it('selects by current decision and never picks a sealed row', () => {
    expect(idsWithDecision(people, decisions, ['maybe_yes'])).toEqual(['d']);
    expect(idsWithDecision(people, decisions, ['maybe_yes', 'maybe_no'])).toEqual(['a', 'd']);
  });
});

describe('ballot helpers', () => {
  const ballots = [
    { roundNumber: 1, yesCount: 3, noCount: 5, closedAt: '2026-09-15T02:00:00Z', decisionApplied: null },
    { roundNumber: 2, yesCount: 6, noCount: 2, closedAt: '2026-09-15T02:05:00Z', decisionApplied: 'maybe_yes' }
  ];

  it('picks the latest round', () => {
    expect(latestBallot(ballots).roundNumber).toBe(2);
    expect(latestBallot([])).toBeNull();
  });

  it('colours by which side won', () => {
    expect(ballotTone({ yesCount: 6, noCount: 2 })).toBe('success');
    expect(ballotTone({ yesCount: 1, noCount: 2 })).toBe('error');
    expect(ballotTone({ yesCount: 2, noCount: 2 })).toBe('default');
  });

  it('describes a round with its applied decision', () => {
    expect(formatBallotLine(ballots[1])).toMatch(/Round 2 · 6 yes \/ 2 no · Decision: Maybe Yes$/);
    expect(formatBallotLine(ballots[0])).not.toMatch(/Decision/);
  });
});
