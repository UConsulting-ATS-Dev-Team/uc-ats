// How a time is written on a candidate-facing page.
//
// Everything recruitment runs happens on campus, so slots are displayed in
// Pacific regardless of where the person reading is sitting - a candidate
// travelling, or one whose laptop clock is set to somewhere else, must not be
// shown a time an hour out from the one on the door. That is the single worst
// bug a scheduling feature can have, and the defence is that one constant lives
// in one file rather than being retyped per page.

export const DISPLAY_TIME_ZONE = 'America/Los_Angeles';

/** "Monday, October 6 at 9:00 AM" */
export const formatDateTime = (dateTime) =>
  new Date(dateTime).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: DISPLAY_TIME_ZONE,
  });

/** "9:00 AM" */
export const formatTime = (dateTime) =>
  new Date(dateTime).toLocaleString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: DISPLAY_TIME_ZONE,
  });

/** "Monday, October 6" */
export const formatDay = (dateTime) =>
  new Date(dateTime).toLocaleString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: DISPLAY_TIME_ZONE,
  });

/**
 * "9:00 AM - 10:30 AM", or the full date and time when the range spans days.
 * Used as a slot heading wherever the slot has no label of its own.
 */
export const formatTimeRange = (startTime, endTime) => {
  if (!endTime) return formatDateTime(startTime);
  const sameDay = formatDay(startTime) === formatDay(endTime);
  return sameDay
    ? `${formatTime(startTime)} - ${formatTime(endTime)}`
    : `${formatDateTime(startTime)} - ${formatDateTime(endTime)}`;
};
