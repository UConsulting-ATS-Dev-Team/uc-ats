import { describe, it, expect } from 'vitest';
import { ACCEPTED_ROUND, ROUNDS, getRound, isFinalRound, nextRound } from './roundProgression.js';

describe('round progression', () => {
  it('runs resume review, coffee chats, first round, final round', () => {
    expect(ROUNDS.map((round) => round.stage)).toEqual(['RESUME_REVIEW', 'COFFEE_CHAT', 'FIRST_ROUND', 'FINAL_ROUND']);
  });

  it('advances each round to the next, and nothing past the final round', () => {
    expect(nextRound('1').round).toBe('2');
    expect(nextRound('3').round).toBe('4');
    expect(nextRound('4')).toBeNull();
  });

  it('knows which round is last, and that acceptance sits past it', () => {
    expect(isFinalRound('4')).toBe(true);
    expect(isFinalRound('3')).toBe(false);
    expect(getRound(ACCEPTED_ROUND)).toBeNull();
  });

  it('accepts numeric rounds and rejects unknown ones', () => {
    expect(getRound(2).phase).toBe('coffee');
    expect(getRound('9')).toBeNull();
    expect(nextRound('9')).toBeNull();
  });
});
