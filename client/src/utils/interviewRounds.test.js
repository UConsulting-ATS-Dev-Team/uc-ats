import { describe, it, expect } from 'vitest';
import {
  applicationsForInterview,
  roundLabelForInterview,
  emptyRoundMessage,
} from './interviewRounds';

// currentRound values mirror server/src/utils/roundProgression.js
const applications = [
  { id: 'a1', name: 'Resume Person', currentRound: '1' },
  { id: 'a2', name: 'Coffee Person', currentRound: '2' },
  { id: 'a3', name: 'First Round Person', currentRound: '3' },
  { id: 'a4', name: 'Final Round Person', currentRound: '4' },
  { id: 'a5', name: 'Accepted Person', currentRound: '5' },
];

const names = (rows) => rows.map((r) => r.name);

describe('applicationsForInterview', () => {
  it('offers each interview type the candidates actually in that round', () => {
    expect(names(applicationsForInterview(applications, 'COFFEE_CHAT'))).toEqual(['Coffee Person']);
    expect(names(applicationsForInterview(applications, 'ROUND_ONE'))).toEqual(['First Round Person']);
    expect(names(applicationsForInterview(applications, 'FINAL_ROUND'))).toEqual(['Final Round Person']);
  });

  it('treats Round 2 as the final round, like the rest of the app', () => {
    expect(names(applicationsForInterview(applications, 'ROUND_TWO'))).toEqual(['Final Round Person']);
  });

  it('falls back to the whole cycle for a type with no round of its own', () => {
    expect(applicationsForInterview(applications, 'DELIBERATIONS')).toHaveLength(5);
    expect(applicationsForInterview(applications, undefined)).toHaveLength(5);
  });

  it('tolerates a numeric currentRound and a missing list', () => {
    expect(names(applicationsForInterview([{ id: 'n', name: 'Numeric', currentRound: 3 }], 'ROUND_ONE'))).toEqual(['Numeric']);
    expect(applicationsForInterview(undefined, 'ROUND_ONE')).toEqual([]);
  });

  it('does not fall back to status, which goes stale as a cycle advances', () => {
    // Every one of these is UNDER_REVIEW, but only the round decides.
    const stale = [
      { id: 's1', name: 'Stale One', currentRound: '1', status: 'UNDER_REVIEW' },
      { id: 's2', name: 'Stale Two', currentRound: '3', status: 'REJECTED' },
    ];
    expect(names(applicationsForInterview(stale, 'ROUND_ONE'))).toEqual(['Stale Two']);
  });
});

describe('labels', () => {
  it('names the round in the heading and the empty state', () => {
    expect(roundLabelForInterview('ROUND_ONE')).toBe('First Round Applications:');
    expect(roundLabelForInterview('COFFEE_CHAT')).toBe('Coffee Chat Round Applications:');
    expect(emptyRoundMessage('FINAL_ROUND')).toBe('No applications in final round');
  });

  it('stays generic for an unmapped type', () => {
    expect(roundLabelForInterview('DELIBERATIONS')).toBe('Applications:');
    expect(emptyRoundMessage('DELIBERATIONS')).toBe('No applications in this cycle');
  });
});
