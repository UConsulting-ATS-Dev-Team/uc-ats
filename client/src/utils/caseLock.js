// A case the member is assigned to but may not read yet answers 423 with this
// code and an `unlocksAt` timestamp. A case that is not theirs at all still
// answers a plain 403, so the two never get the same message.
// See server/src/services/caseVisibility.js.
export const CASE_LOCKED_CODE = 'CASE_LOCKED';

export const isCaseLockedError = (error) =>
  error?.status === 423 && error?.code === CASE_LOCKED_CODE;

export const caseUnlocksAt = (error) => {
  const raw = error?.body?.unlocksAt;
  if (!raw) return null;
  const when = new Date(raw);
  return Number.isNaN(when.getTime()) ? null : when;
};

// "in 3 hours" / "in 25 minutes" — the wait is what the member cares about, and
// it stays honest if their clock is in another timezone than the interview.
export const formatUnlockWait = (unlocksAt, now = new Date()) => {
  if (!unlocksAt) return null;
  const minutes = Math.ceil((unlocksAt.getTime() - now.getTime()) / 60000);
  if (minutes <= 0) return 'in a moment';
  if (minutes < 60) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in about ${hours} hour${hours === 1 ? '' : 's'}`;
  return `in about ${Math.round(hours / 24)} days`;
};
