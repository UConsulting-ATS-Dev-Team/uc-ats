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

const pacificParts = (date) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: DISPLAY_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const part = (type) => Number(parts.find((p) => p.type === type).value);
  return { year: part('year'), month: part('month'), day: part('day'), hour: part('hour'), minute: part('minute') };
};

/**
 * An instant as the Pacific "YYYY-MM-DDTHH:mm" an edit form shows. Read in
 * Pacific, like every time on display, so a laptop set to another zone does not
 * load the form with different hours from the ones on the page behind it.
 */
export const toPacificInput = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const { year, month, day, hour, minute } = pacificParts(date);
  const pad = (n) => String(n).padStart(2, '0');
  return `${year}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}`;
};

/**
 * The inverse: a Pacific "YYYY-MM-DDTHH:mm" from a form, as an instant. Mirrors
 * localInputToUTC on the server.
 */
export const fromPacificInput = (value) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value ?? '');
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  const wanted = Date.UTC(year, month - 1, day, hour, minute);
  let guess = wanted;
  // The first correction finds the offset; a second catches a guess that
  // landed on the other side of a daylight-saving change.
  for (let i = 0; i < 3; i += 1) {
    const seen = pacificParts(new Date(guess));
    const diff = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute) - wanted;
    if (diff === 0) break;
    guess -= diff;
  }
  return new Date(guess);
};
