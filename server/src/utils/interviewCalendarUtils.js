// Pure helpers for the interview -> Google Calendar integration.
// Kept free of Prisma/Google imports so they can be unit tested in isolation.

const TIMEZONE = 'America/Los_Angeles';

const INTERVIEW_TYPE_LABELS = {
  COFFEE_CHAT: 'Coffee Chat',
  ROUND_ONE: 'Round 1',
  ROUND_TWO: 'Round 2',
  FINAL_ROUND: 'Final Round',
  DELIBERATIONS: 'Deliberations'
};

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Google Calendar event IDs must be base32hex (characters 0-9 and a-v), 5-1024 chars.
// A UUID with the dashes stripped already satisfies that, so the interview ID maps to a stable
// event ID and a retried create can never produce a second event.
export function buildInterviewEventId(interviewId) {
  const normalized = String(interviewId || '')
    .toLowerCase()
    .replace(/[^0-9a-v]/g, '');
  if (normalized.length < 3) {
    throw new Error(`Cannot derive a calendar event ID from interview ID "${interviewId}"`);
  }
  return `ucats${normalized}`;
}

export function isValidAttendeeEmail(email) {
  return typeof email === 'string' && EMAIL_PATTERN.test(email.trim());
}

export function normalizeEmail(email) {
  return String(email).trim().toLowerCase();
}

// The admin UI stores the interviewer roster as JSON in Interview.description
// ({ memberGroups: [{ memberIds: [...] }] }). Assignment rows are the newer source of truth, so
// the roster is the union of both.
export function collectAssignedUserIds(interview) {
  const ids = new Set();

  for (const assignment of interview?.assignments || []) {
    if (assignment?.userId) ids.add(assignment.userId);
  }

  for (const group of parseInterviewConfig(interview?.description).memberGroups || []) {
    for (const memberId of group?.memberIds || []) {
      if (memberId) ids.add(memberId);
    }
  }

  return [...ids];
}

export function parseInterviewConfig(description) {
  if (!description) return {};
  if (typeof description === 'object') return description;
  try {
    const parsed = JSON.parse(description);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// Splits resolved interviewer users into the emails to invite and the ones an admin must fix.
export function partitionAttendees(users) {
  const invited = new Set();
  const invalid = [];

  for (const user of users || []) {
    if (isValidAttendeeEmail(user?.email)) {
      invited.add(normalizeEmail(user.email));
    } else {
      invalid.push(user?.fullName || user?.id || 'unknown user');
    }
  }

  return { attendees: [...invited].sort(), invalid };
}

export function diffAttendees(previous = [], next = []) {
  const before = new Set((previous || []).map(normalizeEmail));
  const after = new Set((next || []).map(normalizeEmail));

  return {
    added: [...after].filter((email) => !before.has(email)).sort(),
    removed: [...before].filter((email) => !after.has(email)).sort(),
    unchanged: [...after].filter((email) => before.has(email)).sort()
  };
}

// Interview.description holds internal JSON configuration, so nothing from it is ever copied into
// the invite. Only operational session details go to interviewers' calendars.
// `rosterSize` is the real interviewer count, which differs from `attendeeEmails` when
// CALENDAR_INVITE_TEST_EMAIL redirects the invite to a single test address.
export function buildInterviewEventPayload({ interview, attendeeEmails = [], rosterSize, clientUrl }) {
  if (!interview?.startDate || !interview?.endDate) {
    throw new Error('Interview is missing a start or end date');
  }

  const start = new Date(interview.startDate);
  const end = new Date(interview.endDate);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error('Interview has an invalid start or end date');
  }
  if (end <= start) {
    throw new Error('Interview end date must be after its start date');
  }

  const cycleName = interview.cycle?.name || null;
  const roundLabel = INTERVIEW_TYPE_LABELS[interview.interviewType] || interview.interviewType || 'Interview';
  const location = sanitizeText(interview.location);

  const lines = [
    `${roundLabel} interview session${cycleName ? ` for the ${sanitizeText(cycleName)} recruiting cycle` : ''}.`,
    '',
    `Session: ${sanitizeText(interview.title) || roundLabel}`,
    `Round: ${roundLabel}`,
    `Session ID: ${interview.id}`
  ];
  if (location) lines.push(isLink(location) ? `Video link: ${location}` : `Location: ${location}`);
  if (interview.dresscode) lines.push(`Dress code: ${sanitizeText(interview.dresscode)}`);
  lines.push(`Interviewers invited: ${rosterSize ?? attendeeEmails.length}`);
  if (clientUrl) lines.push('', `Candidate assignments and prep materials: ${clientUrl}/admin/assigned-interviews`);
  lines.push('', 'You are receiving this invite because you are assigned to this interview in the UConsulting ATS.');

  return {
    summary: buildSummary({ cycleName, roundLabel, title: interview.title }),
    location: location || undefined,
    description: lines.join('\n'),
    start: { dateTime: start.toISOString(), timeZone: TIMEZONE },
    end: { dateTime: end.toISOString(), timeZone: TIMEZONE },
    attendees: attendeeEmails.map((email) => ({ email }))
  };
}

function buildSummary({ cycleName, roundLabel, title }) {
  const cleanTitle = sanitizeText(title);
  const base = cleanTitle && cleanTitle !== roundLabel ? `${roundLabel}: ${cleanTitle}` : roundLabel;
  return sanitizeText(`UConsulting ${base}${cycleName ? ` (${cycleName})` : ''}`).slice(0, 200);
}

function isLink(value) {
  return /^https?:\/\//i.test(value);
}

function sanitizeText(value) {
  if (value === null || value === undefined) return '';
  return String(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED']);

export function calendarErrorStatus(error) {
  return error?.code || error?.response?.status || null;
}

// Patches when an event ID is already stored, otherwise inserts under the deterministic ID.
// A 409 means an earlier attempt already created the event (patch it instead of duplicating it);
// a 404/410 means it was deleted in Google Calendar directly (recreate it).
export async function upsertCalendarEvent({ eventId, storedEventId, payload, insertEvent, patchEvent }) {
  if (storedEventId) {
    try {
      return await patchEvent(storedEventId, payload);
    } catch (error) {
      const status = calendarErrorStatus(error);
      if (status !== 404 && status !== 410) throw error;
    }
  }

  try {
    return await insertEvent(eventId, payload);
  } catch (error) {
    if (calendarErrorStatus(error) === 409) {
      return patchEvent(eventId, payload);
    }
    throw error;
  }
}

export function isTransientCalendarError(error) {
  const status = calendarErrorStatus(error);
  if (TRANSIENT_STATUSES.has(status)) return true;
  if (typeof error?.code === 'string' && TRANSIENT_CODES.has(error.code)) return true;
  return TRANSIENT_CODES.has(error?.cause?.code);
}

// Turns a Google API failure into something an admin can act on in the UI.
export function describeCalendarError(error) {
  const status = typeof error?.code === 'number' ? error.code : error?.response?.status;
  const reason = error?.errors?.[0]?.reason || error?.response?.data?.error?.errors?.[0]?.reason;
  const detail = error?.message || 'Unknown error';

  if (status === 401) {
    return `Google Calendar rejected the ATS credentials (401). Check GOOGLE_CLOUD_KEY_PATH and re-authorize the service account. Details: ${detail}`;
  }
  if (status === 403 && (reason === 'rateLimitExceeded' || reason === 'userRateLimitExceeded' || reason === 'quotaExceeded')) {
    return `Google Calendar quota exceeded (403 ${reason}). Invites will need to be retried later. Details: ${detail}`;
  }
  if (status === 403) {
    return `The ATS service account is not allowed to write to the configured calendar (403). Share GOOGLE_CALENDAR_ID with the service account and grant "Make changes to events". Details: ${detail}`;
  }
  if (status === 429) {
    return `Google Calendar rate limited the request (429). Retry the sync in a few minutes. Details: ${detail}`;
  }
  if (status === 400) {
    return `Google Calendar rejected the invite payload (400) — usually a malformed interviewer email or an invalid start/end time. Details: ${detail}`;
  }
  return `Calendar sync failed: ${detail}`;
}

// Retries transient Google failures with exponential backoff. `sleep` is injectable for tests.
export async function withCalendarRetry(operation, { attempts = 3, baseDelayMs = 500, sleep = defaultSleep } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isTransientCalendarError(error)) throw error;
      await sleep(baseDelayMs * 2 ** (attempt - 1));
    }
  }
  throw lastError;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export { TIMEZONE, INTERVIEW_TYPE_LABELS };
