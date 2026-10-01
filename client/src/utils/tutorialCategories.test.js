import { describe, it, expect } from 'vitest';
import { CATEGORY_LABELS, GATE_COPY, tutorialCategoryForInterviewType } from './tutorialCategories';

describe('tutorialCategoryForInterviewType', () => {
  it('maps every interview round to its own tutorial category', () => {
    expect(tutorialCategoryForInterviewType('COFFEE_CHAT')).toBe('COFFEE_CHATS');
    expect(tutorialCategoryForInterviewType('ROUND_ONE')).toBe('FIRST_ROUND');
    expect(tutorialCategoryForInterviewType('FINAL_ROUND')).toBe('FINAL_ROUND');
    // The final round under its old name, as everywhere else in the app.
    expect(tutorialCategoryForInterviewType('ROUND_TWO')).toBe('FINAL_ROUND');
  });

  it('gates nothing for a type with no tutorials', () => {
    expect(tutorialCategoryForInterviewType('DELIBERATIONS')).toBeNull();
    expect(tutorialCategoryForInterviewType(undefined)).toBeNull();
  });

  it('has a label and gate wording for every category it can return', () => {
    for (const type of ['COFFEE_CHAT', 'ROUND_ONE', 'ROUND_TWO', 'FINAL_ROUND']) {
      const category = tutorialCategoryForInterviewType(type);
      expect(CATEGORY_LABELS[category]).toBeTruthy();
      expect(GATE_COPY[category]?.when).toBeTruthy();
    }
  });
});
