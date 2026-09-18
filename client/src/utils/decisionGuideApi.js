import apiClient from './api';

// Deliberation decision guide endpoints (server/src/routes/decisionGuides.js).
// Reading is open to admins and members; writing is admin-only.

const base = '/decision-guides';

const decisionGuideApi = {
  /** Every phase at once, with what is stored on each. Admin editor. */
  all: () => apiClient.get(base),
  /** The resolved copy for one phase, inheritance already applied. */
  forPhase: (phase) => apiClient.get(`${base}/${phase}`),
  save: (phase, { intro, criteria }) => apiClient.put(`${base}/${phase}`, { intro, criteria }),
  /** Drops this phase's own wording so it inherits again. */
  reset: (phase) => apiClient.delete(`${base}/${phase}`)
};

export default decisionGuideApi;
