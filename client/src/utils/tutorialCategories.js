// The tutorial categories, as Help and Help Management show them, and which ones gate
// work. Mirrors the TutorialCategory enum and TUTORIAL_CATEGORIES in the server's help
// routes; GATED_CATEGORIES in server/src/services/tutorialGate.js decides which gate.

export const CATEGORY_LABELS = {
  DOCUMENT_GRADING: 'Document Grading',
  INTERVIEW_CONDUCT: 'Interviews',
  COFFEE_CHATS: 'Coffee Chats',
  FIRST_ROUND: 'First Round',
  FINAL_ROUND: 'Final Round',
  GTKUC: 'Get to Know UC',
  ATS_NAVIGATION: 'ATS Navigation',
  NEW_FEATURES: 'New Features',
};

export const CATEGORY_COLORS = {
  DOCUMENT_GRADING: 'primary',
  INTERVIEW_CONDUCT: 'secondary',
  COFFEE_CHATS: 'secondary',
  FIRST_ROUND: 'secondary',
  FINAL_ROUND: 'secondary',
  GTKUC: 'success',
  ATS_NAVIGATION: 'info',
  NEW_FEATURES: 'warning',
};

export const TUTORIAL_CATEGORIES = Object.keys(CATEGORY_LABELS);

/** What the gate popup says, and its button, per gated category. */
export const GATE_COPY = {
  DOCUMENT_GRADING: { when: 'before you grade', continueLabel: 'Start grading' },
  COFFEE_CHATS: { when: 'before you run a coffee chat', continueLabel: 'Start the interview' },
  FIRST_ROUND: { when: 'before you run a first round', continueLabel: 'Start the interview' },
  FINAL_ROUND: { when: 'before you run a final round', continueLabel: 'Start the interview' },
};

/**
 * The tutorial category whose gate an interview of this type sits behind, or null for
 * a type with no tutorials (DELIBERATIONS). ROUND_TWO is the final round under its old
 * name, as everywhere else in the app.
 */
export function tutorialCategoryForInterviewType(interviewType) {
  switch (interviewType) {
    case 'COFFEE_CHAT':
      return 'COFFEE_CHATS';
    case 'ROUND_ONE':
      return 'FIRST_ROUND';
    case 'ROUND_TWO':
    case 'FINAL_ROUND':
      return 'FINAL_ROUND';
    default:
      return null;
  }
}
