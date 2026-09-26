// Client copy of the self-service cutoff in server/src/utils/schedulingWindows.js.
// The server enforces it; this only decides whether to offer the buttons. Pages
// prefer a server-sent canModify / modifyCutoffHours when the payload has one.

export const MODIFY_CUTOFF_HOURS = 12;

export const hoursUntil = (startTime) =>
  (new Date(startTime).getTime() - Date.now()) / (1000 * 60 * 60);

export const canModify = (startTime, cutoffHours = MODIFY_CUTOFF_HOURS) =>
  hoursUntil(startTime) >= cutoffHours;

// The Get to Know UC booking that counts against this cycle's limit of one:
// upcoming, and inside the cycle's dates when the cycle has any. `getStart`
// reads the start time off whichever signup shape the page has.
export const currentCycleBooking = (signups, cycle, getStart) => {
  if (!Array.isArray(signups)) return null;
  const now = Date.now();
  const startDate = cycle?.startDate ? new Date(cycle.startDate) : null;
  const endDate = cycle?.endDate ? new Date(cycle.endDate) : null;
  return (
    signups.find((signup) => {
      const start = getStart(signup);
      if (!start) return false;
      const when = new Date(start);
      if (when.getTime() < now) return false;
      if (startDate && when < startDate) return false;
      if (endDate && when > endDate) return false;
      return true;
    }) || null
  );
};

// The server's own sentence when it sent one, without the "(Status: 409)" suffix.
export const errorText = (e, fallback) => e?.serverMessage || e?.message || fallback;
