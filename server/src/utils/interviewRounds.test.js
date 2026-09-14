import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  STAGE_FOR_INTERVIEW_TYPE,
  interviewTypesForRound,
  isCandidateEligibleForInterview,
  roundForInterviewType,
  roundNumberForInterviewType,
} from './interviewRounds.js';
import { ROUNDS } from './roundProgression.js';

// Read the enum out of the schema rather than importing it from @prisma/client.
// The generated client is a build artefact that goes stale across branches (see
// CLAUDE.md), and the thing under test is whether the mapping keeps up with the
// schema - so the schema is what to compare against.
const schemaPath = fileURLToPath(new URL('../../prisma/schema.prisma', import.meta.url));
const interviewTypeValues = readFileSync(schemaPath, 'utf8')
  .match(/enum\s+InterviewType\s*\{([^}]*)\}/)[1]
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, '').trim())
  .filter(Boolean);

describe('interview type to round mapping', () => {
  it('finds the InterviewType enum in the schema', () => {
    expect(interviewTypeValues.length).toBeGreaterThan(0);
    expect(interviewTypeValues).toContain('COFFEE_CHAT');
  });

  // The guard rail. Adding an InterviewType without deciding its round fails here
  // rather than silently mapping to undefined at runtime.
  it.each(interviewTypeValues)('maps %s to a real round or an explicit null', (type) => {
    expect(Object.prototype.hasOwnProperty.call(STAGE_FOR_INTERVIEW_TYPE, type)).toBe(true);

    const stage = STAGE_FOR_INTERVIEW_TYPE[type];
    if (stage === null) return;
    expect(ROUNDS.map((round) => round.stage)).toContain(stage);
  });

  it('draws each interview from the round its candidates are sitting in', () => {
    expect(roundNumberForInterviewType('COFFEE_CHAT')).toBe('2');
    expect(roundNumberForInterviewType('ROUND_ONE')).toBe('3');
    expect(roundNumberForInterviewType('FINAL_ROUND')).toBe('4');
  });

  it('treats ROUND_TWO as the legacy alias of FINAL_ROUND', () => {
    expect(roundNumberForInterviewType('ROUND_TWO')).toBe('4');
    expect(interviewTypesForRound('4')).toEqual(
      expect.arrayContaining(['ROUND_TWO', 'FINAL_ROUND'])
    );
  });

  it('gives deliberations and unknown types no round', () => {
    expect(roundForInterviewType('DELIBERATIONS')).toBeNull();
    expect(roundForInterviewType('NOT_A_TYPE')).toBeNull();
    expect(roundNumberForInterviewType('DELIBERATIONS')).toBeNull();
  });

  it('lists every type serving a round, and nothing for a round with none', () => {
    expect(interviewTypesForRound('2')).toEqual(['COFFEE_CHAT']);
    expect(interviewTypesForRound(3)).toEqual(['ROUND_ONE']);
    expect(interviewTypesForRound('1')).toEqual([]);
  });

  it('matches a candidate to an interview by the round they are sitting in', () => {
    expect(isCandidateEligibleForInterview('2', 'COFFEE_CHAT')).toBe(true);
    expect(isCandidateEligibleForInterview(3, 'ROUND_ONE')).toBe(true);
    // Someone still in resume review has no business in a coffee chat.
    expect(isCandidateEligibleForInterview('1', 'COFFEE_CHAT')).toBe(false);
    expect(isCandidateEligibleForInterview('2', 'DELIBERATIONS')).toBe(false);
  });
});
