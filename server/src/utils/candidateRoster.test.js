// Naming a session's candidates for the interviewer running it.
import { describe, it, expect } from 'vitest';
import { describeRoster, ROSTER_NAME_LIMIT } from './candidateRoster.js';

const candidate = (firstName, lastName, groupLabel = null) => ({
  groupLabel,
  application: { firstName, lastName },
});

describe('describeRoster', () => {
  it('is null for a session nobody has booked yet', () => {
    expect(describeRoster([])).toBeNull();
    expect(describeRoster(undefined)).toBeNull();
    expect(describeRoster(null)).toBeNull();
  });

  it('names a first-round session, where the session is the group', () => {
    expect(describeRoster([candidate('Ada', 'Lovelace'), candidate('Grace', 'Hopper')])).toBe(
      'Ada Lovelace, Grace Hopper'
    );
  });

  it('leads with the rotation label, which is what identifies a pair at a coffee chat table', () => {
    expect(describeRoster([candidate('Ada', 'Lovelace', '1A'), candidate('Grace', 'Hopper', '1B')])).toBe(
      '1A: Ada Lovelace, 1B: Grace Hopper'
    );
  });

  it('skips a row with no name rather than printing a bare label', () => {
    const rows = [candidate('Ada', 'Lovelace'), { groupLabel: '1B', application: {} }, { groupLabel: '2A' }];
    expect(describeRoster(rows)).toBe('Ada Lovelace');
  });

  it('counts the rest once a session is too big to list', () => {
    const many = Array.from({ length: ROSTER_NAME_LIMIT + 8 }, (_, i) => candidate('Cand', `Number${i}`));
    const line = describeRoster(many);
    expect(line).toContain('(+8 more)');
    // Exactly the limit is named, and no more.
    expect(line.split(', ').length).toBe(ROSTER_NAME_LIMIT);
  });

  it('does not add a count when the session fits exactly', () => {
    const exact = Array.from({ length: ROSTER_NAME_LIMIT }, (_, i) => candidate('Cand', `Number${i}`));
    expect(describeRoster(exact)).not.toContain('more)');
  });
});
