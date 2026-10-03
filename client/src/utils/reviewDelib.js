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

// Each viewer's step lives in the URL (?step=outliers&c=<applicationId>), so a
// refresh keeps their place. Anything unknown is the overview.
const STEP_PARAMS = Object.freeze({ OVERVIEW: 'overview', OUTLIERS: 'outliers', ALL: 'all', SUMMARY: 'summary' });
export const stepToParam = (step) => STEP_PARAMS[step] || STEP_PARAMS.OVERVIEW;
export const stepFromParam = (value) =>
  Object.keys(STEP_PARAMS).find((step) => STEP_PARAMS[step] === value) || 'OVERVIEW';

/**
 * Where a viewer on the Outliers step stands once the walkthrough changes under
 * them (an admin moved the threshold), or when they arrive. The same candidate
 * while they are still listed and can be shown; else the next one after them
 * that can; else the last that can; and the first that can when they were on
 * none. `canShow` says no for a sealed or moved candidate, which has no card.
 */
export function walkthroughPosition(before, after, current, canShow = () => true) {
  const showable = after.filter(canShow);
  if (current && showable.includes(current)) return current;
  const list = after.includes(current) ? after : before;
  const index = current ? list.indexOf(current) : -1;
  if (index === -1) return showable[0] ?? null;
  return list.slice(index + 1).find((id) => showable.includes(id)) ?? showable.at(-1) ?? null;
}

/** The next (`direction` 1) or previous (-1) candidate in the walkthrough that can be shown, or null. */
export function walkthroughNeighbour(order, current, direction, canShow = () => true) {
  const index = order.indexOf(current);
  if (index === -1) return direction > 0 ? order.find(canShow) ?? null : null;
  for (let i = index + direction; i >= 0 && i < order.length; i += direction) {
    if (canShow(order[i])) return order[i];
  }
  return null;
}

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

/** 1st, 2nd, 3rd, 11th: Staging's rank tooltip wording. */
export const ordinal = (n) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${{ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th'}`;
};

export const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

export const elapsed = (ms) => {
  const total = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};
