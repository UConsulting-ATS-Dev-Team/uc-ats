import { DISPLAY_TIME_ZONE } from '../../utils/scheduleFormat';

export const ROLES = ['ADMIN', 'MEMBER', 'CANDIDATE', 'TALENT', 'CLIENT', 'ANON'];

export const ROLE_LABELS = {
  ALL: 'Everyone',
  ADMIN: 'Admins',
  MEMBER: 'Members',
  CANDIDATE: 'Candidates',
  TALENT: 'Talent portal',
  CLIENT: 'Partner clients',
  ANON: 'Signed out',
};

/** A theme colour per role, so a role looks the same on every chart. */
export function roleColors(theme) {
  return {
    ADMIN: theme.palette.primary.main,
    MEMBER: theme.palette.secondary.main,
    CANDIDATE: theme.palette.success.main,
    TALENT: theme.palette.info.main,
    CLIENT: theme.palette.warning.main,
    ANON: theme.palette.grey[500],
  };
}

const number = new Intl.NumberFormat('en-US');

export const fmtNum = (v) => (v === null || v === undefined ? '—' : number.format(v));

export function fmtMs(v) {
  if (v === null || v === undefined) return '—';
  if (v >= 10_000) return `${(v / 1000).toFixed(0)} s`;
  if (v >= 1000) return `${(v / 1000).toFixed(1)} s`;
  return `${Math.round(v)} ms`;
}

export function fmtPct(v, digits = 1) {
  if (v === null || v === undefined) return '—';
  return `${(v * 100).toFixed(digits)}%`;
}

/** '2026-09-27' -> 'Sep 27'. Days are already Los Angeles days; no zone conversion. */
export function fmtDay(day) {
  const [y, m, d] = String(day).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** 'Sep 27, 9:04 AM', in the zone the rest of the app displays. */
export const fmtWhen = (value) =>
  value
    ? new Date(value).toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        timeZone: DISPLAY_TIME_ZONE,
      })
    : '—';

/** Web vitals: CLS is a unitless score, the rest are milliseconds. */
export const fmtVital = (name, v) => (v === null || v === undefined ? '—' : name === 'CLS' ? v.toFixed(3) : fmtMs(v));

/** Google's "good" / "needs improvement" thresholds for each vital. */
export const VITAL_THRESHOLDS = {
  LCP: [2500, 4000],
  INP: [200, 500],
  CLS: [0.1, 0.25],
  TTFB: [800, 1800],
};

export const VITAL_LABELS = {
  LCP: 'Largest paint (LCP)',
  INP: 'Response to input (INP)',
  CLS: 'Layout shift (CLS)',
  TTFB: 'Server first byte (TTFB)',
};

export function vitalRating(name, v) {
  const t = VITAL_THRESHOLDS[name];
  if (!t || v === null || v === undefined) return 'default';
  if (v <= t[0]) return 'success';
  if (v <= t[1]) return 'warning';
  return 'error';
}

/**
 * Relative change from `before` to `after`, or null when there is nothing to
 * compare against.
 */
export function change(after, before) {
  if (after === null || after === undefined || before === null || before === undefined) return null;
  if (before === 0) return after === 0 ? 0 : null;
  return (after - before) / before;
}
