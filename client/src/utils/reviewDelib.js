import { formatScore } from './documentRubrics';

// Labels and number formatting shared by the review team deliberation screens.

export const DOC_TYPES = Object.freeze(['resume', 'coverLetter', 'video']);

export const DOC_LABELS = Object.freeze({ resume: 'Resume', coverLetter: 'Cover letter', video: 'Video' });

export const STEPS = Object.freeze([
  { id: 'OVERVIEW', label: 'Overview' },
  { id: 'OUTLIERS', label: 'Outliers' },
  { id: 'ALL', label: 'All candidates' },
  { id: 'SUMMARY', label: 'Summary' }
]);

export const THRESHOLD_OPTIONS = Object.freeze([0.1, 0.15, 0.2, 0.25, 0.3, 0.35, 0.4, 0.5, 0.6]);

/** The meeting's soft length; the timer turns amber after it. */
export const MEETING_MS = 10 * 60 * 1000;

export const percent = (fraction) =>
  (fraction === null || fraction === undefined ? '–' : `${Math.round(fraction * 100)}%`);

export const score = (value) => (value === null || value === undefined ? '–' : formatScore(value));

/** +1.5 / −2 / 0, with a real minus sign. */
export const signed = (value) => {
  if (value === null || value === undefined) return '–';
  const rounded = Math.round(value * 100) / 100;
  if (rounded === 0) return '0';
  return rounded > 0 ? `+${formatScore(rounded)}` : `−${formatScore(-rounded)}`;
};

export const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export const elapsed = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
