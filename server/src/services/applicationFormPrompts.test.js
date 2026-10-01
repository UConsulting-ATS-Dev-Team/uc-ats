// Graders see the short answer's question read live from the cycle's Google
// Form. These pin down which question that is, and that every way the read can
// fail leaves the grading page with no prompt rather than an error.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { getFormQuestions } from './google/forms.js';
import { getCycleQuestionPrompt, clearFormPromptCache } from './applicationFormPrompts.js';

vi.mock('../prismaClient.js', () => ({
  default: { recruitingCycle: { findUnique: vi.fn() } },
}));
vi.mock('./google/forms.js', () => ({ getFormQuestions: vi.fn() }));
vi.mock('../config.js', () => ({
  default: {
    form: {
      database_mappings: {
        q_email: { field: 'email', type: 'string' },
        q_short: { field: 'shortAnswer', type: 'string' },
      },
    },
  },
}));

const FORM_URL = 'https://docs.google.com/forms/d/form-abc/edit';
const item = (questionId, title, description) => ({
  title,
  description,
  questionItem: { question: { questionId } },
});

beforeEach(() => {
  vi.clearAllMocks();
  clearFormPromptCache();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  prisma.recruitingCycle.findUnique.mockResolvedValue({ formUrl: FORM_URL });
});

describe('getCycleQuestionPrompt', () => {
  it('returns the title of the question mapped to the field', async () => {
    getFormQuestions.mockResolvedValue([
      item('q_email', 'Email'),
      item('q_short', 'Why do you want to join UConsulting? (150 words max)'),
    ]);

    await expect(getCycleQuestionPrompt('cycle-1', 'shortAnswer'))
      .resolves.toBe('Why do you want to join UConsulting? (150 words max)');
    expect(getFormQuestions).toHaveBeenCalledWith('form-abc');
  });

  it('adds the description under the title when the form has one', async () => {
    getFormQuestions.mockResolvedValue([item('q_short', 'Short answer', '  Tell us why.  ')]);

    await expect(getCycleQuestionPrompt('cycle-1', 'shortAnswer'))
      .resolves.toBe('Short answer\n\nTell us why.');
  });

  it('is null when the form has no question for that field', async () => {
    getFormQuestions.mockResolvedValue([item('q_email', 'Email')]);

    await expect(getCycleQuestionPrompt('cycle-1', 'shortAnswer')).resolves.toBeNull();
  });

  it('is null without asking Google when the cycle has no usable form link', async () => {
    for (const formUrl of [null, 'https://forms.gle/abc', 'https://docs.google.com/forms/d/e/pub-id/viewform']) {
      prisma.recruitingCycle.findUnique.mockResolvedValue({ formUrl });
      await expect(getCycleQuestionPrompt('cycle-1', 'shortAnswer')).resolves.toBeNull();
    }
    prisma.recruitingCycle.findUnique.mockResolvedValue(null);
    await expect(getCycleQuestionPrompt('missing', 'shortAnswer')).resolves.toBeNull();
    await expect(getCycleQuestionPrompt(undefined, 'shortAnswer')).resolves.toBeNull();
    expect(getFormQuestions).not.toHaveBeenCalled();
  });

  it('is null, not an error, when Google refuses the read', async () => {
    getFormQuestions.mockRejectedValue(new Error('Requested entity was not found'));

    await expect(getCycleQuestionPrompt('cycle-1', 'shortAnswer')).resolves.toBeNull();
  });

  it('reads each form once while cached, including concurrent first reads', async () => {
    getFormQuestions.mockResolvedValue([item('q_short', 'Why us?')]);

    await Promise.all([
      getCycleQuestionPrompt('cycle-1', 'shortAnswer'),
      getCycleQuestionPrompt('cycle-1', 'shortAnswer'),
    ]);
    await getCycleQuestionPrompt('cycle-1', 'shortAnswer');

    expect(getFormQuestions).toHaveBeenCalledTimes(1);
  });

  it('retries a failed read after the shorter failure window', async () => {
    vi.useFakeTimers();
    try {
      getFormQuestions.mockRejectedValueOnce(new Error('boom'));
      await expect(getCycleQuestionPrompt('cycle-1', 'shortAnswer')).resolves.toBeNull();

      getFormQuestions.mockResolvedValue([item('q_short', 'Why us?')]);
      await expect(getCycleQuestionPrompt('cycle-1', 'shortAnswer')).resolves.toBeNull();

      vi.advanceTimersByTime(61 * 1000);
      await expect(getCycleQuestionPrompt('cycle-1', 'shortAnswer')).resolves.toBe('Why us?');
      expect(getFormQuestions).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
