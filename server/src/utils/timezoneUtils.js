// Hardcoded timezone for Los Angeles (handles PST/PDT automatically)
const TIMEZONE = 'America/Los_Angeles';

/**
 * Convert a datetime-local string (YYYY-MM-DDTHH:mm) to a UTC Date
 * Treats input as Los Angeles time
 */
export function localInputToUTC(dateTimeString) {
  if (!dateTimeString) return null;

  // Parse the datetime-local string (YYYY-MM-DDTHH:mm or YYYY-MM-DD HH:mm)
  const normalized = dateTimeString.replace('T', ' ');
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(normalized)) return null;
  const [datePart, timePart] = normalized.split(' ');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hours, minutes] = timePart.split(':').map(Number);

  // Use Intl.DateTimeFormat to convert LA time to UTC
  // We iterate to find the correct UTC time that displays as the desired LA time
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    // h23 rather than hour12:false, which renders midnight as 24:00 of the
    // previous day and made the guess loop settle a day early.
    hourCycle: 'h23'
  });

  // Start with assuming the local time IS the LA time (initial guess)
  let utcGuess = Date.UTC(year, month - 1, day, hours, minutes, 0);

  // Iterate to find the right UTC time
  // Check what this UTC time shows in LA and adjust
  for (let i = 0; i < 3; i++) {
    const guessDate = new Date(utcGuess);
    const laParts = formatter.formatToParts(guessDate);
    const laH = parseInt(laParts.find(p => p.type === 'hour').value);
    const laM = parseInt(laParts.find(p => p.type === 'minute').value);
    const laD = parseInt(laParts.find(p => p.type === 'day').value);
    const laMo = parseInt(laParts.find(p => p.type === 'month').value);
    const laY = parseInt(laParts.find(p => p.type === 'year').value);

    // Calculate difference in minutes
    const diffMinutes = (laY - year) * 525600 + (laMo - month) * 43200 + (laD - day) * 1440 + (laH - hours) * 60 + (laM - minutes);

    if (diffMinutes === 0) break;

    // Adjust guess
    utcGuess -= diffMinutes * 60000;
  }

  return new Date(utcGuess);
}

/**
 * Inverse of localInputToUTC: render a UTC date as the LA-local
 * datetime-local string (YYYY-MM-DDTHH:mm) that produced it.
 */
export function utcToLocalInput(date) {
  if (!date) return null;
  const utcDate = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(utcDate.getTime())) return null;

  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    // h23 rather than hour12:false: the latter renders midnight as 24:00 on the
    // previous day, which would shift the date by one.
    hourCycle: 'h23'
  }).formatToParts(utcDate);

  const part = (type) => parts.find(p => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}T${part('hour')}:${part('minute')}`;
}

/**
 * Format a UTC date for display in Los Angeles time
 * Converts date-fns format tokens to Intl equivalents
 */
export function formatInLA(date, formatString) {
  if (!date) return '';
  const utcDate = date instanceof Date ? date : new Date(date);

  // Create formatters for different parts
  const dayFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    weekday: 'long'
  });

  const monthFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    month: 'long'
  });

  const yearFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    year: 'numeric'
  });

  const dayNumFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    day: 'numeric'
  });

  const timeFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  });

  // Map date-fns tokens to formatted parts
  const dayName = dayFormatter.format(utcDate);
  const monthName = monthFormatter.format(utcDate);
  const year = yearFormatter.format(utcDate);
  const day = dayNumFormatter.format(utcDate);
  const time = timeFormatter.format(utcDate);

  // Handle common date-fns format patterns
  if (formatString === 'EEEE, MMMM d, yyyy, h:mm a') {
    return `${dayName}, ${monthName} ${day}, ${year}, ${time}`;
  }

  if (formatString === 'h:mm a') {
    return time;
  }

  // Fallback: return a generic formatted string
  return new Intl.DateTimeFormat('en-US', {
    timeZone: TIMEZONE,
    dateStyle: 'full',
    timeStyle: 'short'
  }).format(utcDate);
}

/**
 * Format date for email display
 * Example: "Monday, March 15, 2026, 2:30 PM"
 */
export function formatEmailDateTime(date) {
  if (!date) return '';
  return formatInLA(date, 'EEEE, MMMM d, yyyy, h:mm a');
}

/**
 * Format time only for email display
 * Example: "2:30 PM"
 */
export function formatEmailTime(date) {
  if (!date) return '';
  return formatInLA(date, 'h:mm a');
}

export { TIMEZONE };
