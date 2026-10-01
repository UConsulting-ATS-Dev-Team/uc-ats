import { describe, expect, it } from 'vitest';
import { withOwnGrade } from './documentGradingRows';

const team = [{ id: 'me' }, { id: 'teammate' }];
const row = (overrides = {}) => ({
  id: 'app-1',
  groupMembers: team,
  hasResumeScore: false,
  resumeTotalMembers: 2,
  resumeMissingGrades: 2,
  resumeCompletedEvaluators: [],
  hasCoverLetterScore: false,
  coverLetterTotalMembers: 2,
  coverLetterMissingGrades: 1,
  coverLetterCompletedEvaluators: ['teammate'],
  ...overrides
});

describe('withOwnGrade', () => {
  it("marks the grader's own grade and counts it toward the team", () => {
    expect(withOwnGrade(row(), 'resume', 'me')).toMatchObject({
      hasResumeScore: true,
      resumeCompletedEvaluators: ['me'],
      resumeMissingGrades: 1
    });
  });

  it('touches only the graded document', () => {
    const next = withOwnGrade(row(), 'resume', 'me');
    expect(next.hasCoverLetterScore).toBe(false);
    expect(next.coverLetterCompletedEvaluators).toEqual(['teammate']);
  });

  it('does not count a re-grade twice', () => {
    const next = withOwnGrade(row({ resumeCompletedEvaluators: ['me'], resumeMissingGrades: 1 }), 'resume', 'me');
    expect(next.resumeCompletedEvaluators).toEqual(['me']);
    expect(next.resumeMissingGrades).toBe(1);
  });

  it('team-wide, is complete only once every member has graded', () => {
    expect(withOwnGrade(row(), 'resume', 'me', { teamWide: true }).hasResumeScore).toBe(false);
    expect(withOwnGrade(row(), 'coverLetter', 'me', { teamWide: true })).toMatchObject({
      hasCoverLetterScore: true,
      coverLetterMissingGrades: 0
    });
  });

  it('handles the cover letter key, whose flag is not a simple capitalisation of one word', () => {
    expect(withOwnGrade(row(), 'coverLetter', 'me').hasCoverLetterScore).toBe(true);
  });

  it('leaves the counts alone on a row with no team, as the server reports it', () => {
    const lone = row({ groupMembers: [], resumeTotalMembers: 0, resumeMissingGrades: 0 });
    expect(withOwnGrade(lone, 'resume', 'me')).toMatchObject({
      hasResumeScore: true,
      resumeMissingGrades: 0,
      resumeCompletedEvaluators: []
    });
    expect(withOwnGrade(lone, 'resume', 'me', { teamWide: true }).hasResumeScore).toBe(false);
  });
});
