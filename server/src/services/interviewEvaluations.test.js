import { describe, it, expect } from 'vitest';
import {
  firstRoundEvaluationWrite,
  interviewEvaluationWrite,
  readFirstRoundEvaluation,
} from './interviewEvaluations.js';

describe('firstRoundEvaluationWrite', () => {
  it("stores the first round page's post-grading notes, which it sends as notes", () => {
    expect(firstRoundEvaluationWrite({ decision: 'YES', notes: 'Strong on the case' })).toEqual({
      decision: 'YES',
      additionalNotes: 'Strong on the case',
    });
  });

  it('writes the whole evaluation the page sends, scores and per-question notes included', () => {
    const data = firstRoundEvaluationWrite({
      decision: 'MAYBE_YES',
      behavioralLeadership: 4,
      behavioralTotal: 12,
      marketSizingNotes: 'Clean framework',
      behavioralNotes: { q1: 'Great story' },
      notes: 'Post grading',
    });
    expect(data).toEqual({
      decision: 'MAYBE_YES',
      behavioralLeadership: 4,
      behavioralTotal: 12,
      marketSizingNotes: 'Clean framework',
      behavioralNotes: '{"q1":"Great story"}',
      additionalNotes: 'Post grading',
    });
  });

  it('leaves alone whatever a decision-only edit does not send', () => {
    // My Interviews' Edit Evaluation: { decision, notes }. Writing null for the rest
    // erased the interview's behavioral notes.
    const data = firstRoundEvaluationWrite({ decision: 'NO', notes: 'Changed my mind' });
    expect(data).not.toHaveProperty('behavioralNotes');
    expect(data).not.toHaveProperty('behavioralLeadership');
    expect(data).not.toHaveProperty('marketSizingNotes');
  });

  it('prefers additionalNotes when a caller sends it by its own name', () => {
    expect(firstRoundEvaluationWrite({ additionalNotes: 'Direct', notes: 'Alias' }).additionalNotes).toBe('Direct');
  });
});

describe('interviewEvaluationWrite', () => {
  it('leaves case notes and the checklist alone on a decision-only edit', () => {
    // The final round notes wipe: Edit Evaluation sent { decision, notes } and the
    // save nulled behavioralNotes, casingNotes and candidateDetails.
    expect(interviewEvaluationWrite({ decision: 'YES', notes: 'Advance' })).toEqual({
      decision: 'YES',
      notes: 'Advance',
    });
  });

  it('stores the JSON fields the final round page sends as strings', () => {
    expect(
      interviewEvaluationWrite({
        casingNotes: { framework: 'MECE' },
        candidateDetails: { dues: true },
        behavioralNotes: { q1: 'Calm' },
      })
    ).toEqual({
      casingNotes: '{"framework":"MECE"}',
      candidateDetails: '{"dues":true}',
      behavioralNotes: '{"q1":"Calm"}',
    });
  });

  it('keeps a decision the page did not send untouched, and clears one sent as null', () => {
    expect(interviewEvaluationWrite({ notes: 'x' })).not.toHaveProperty('decision');
    expect(interviewEvaluationWrite({ decision: null })).toEqual({ decision: null });
  });
});

describe('readFirstRoundEvaluation', () => {
  it('hands post-grading notes back as notes', () => {
    expect(readFirstRoundEvaluation({ id: 'e1', additionalNotes: 'Saved' })).toMatchObject({ notes: 'Saved', additionalNotes: 'Saved' });
    expect(readFirstRoundEvaluation({ id: 'e2', additionalNotes: null }).notes).toBe('');
  });
});
