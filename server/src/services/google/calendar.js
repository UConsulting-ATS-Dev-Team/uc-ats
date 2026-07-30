import { google } from 'googleapis';
import { getGoogleAuthClient } from './auth.js';
import config from '../../config.js';

const TIMEZONE = 'America/Los_Angeles';
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

let calendarClient;

async function getCalendarClient() {
  if (!calendarClient) {
    const authClient = await getGoogleAuthClient();
    calendarClient = google.calendar({ version: 'v3', auth: authClient });
  }
  return calendarClient;
}

export function buildCalendarEventResource(eventDetails, attendeeEmails, providerEventId = null) {
  const description = `UConsulting Event: ${eventDetails.eventName}${eventDetails.cycleName ? `\nCycle: ${eventDetails.cycleName}` : ''}\n\nThis is a UConsulting recruitment event. You're receiving this invite because you're a relevant UConsulting member or admin.`;

  const resource = {
    summary: eventDetails.eventName,
    location: eventDetails.eventLocation || undefined,
    description,
    start: { dateTime: new Date(eventDetails.eventStartDate).toISOString(), timeZone: TIMEZONE },
    end: { dateTime: new Date(eventDetails.eventEndDate).toISOString(), timeZone: TIMEZONE },
    attendees: attendeeEmails.map((email) => ({ email })),
  };

  if (providerEventId) {
    resource.id = providerEventId;
  }

  return resource;
}

export function buildCalendarAudienceEmails(adminEmails = [], selectedInviteeEmails = []) {
  const seen = new Set();
  const emails = [];
  for (const email of [...(adminEmails || []), ...(selectedInviteeEmails || [])]) {
    const normalized = String(email || '').trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    emails.push(normalized);
  }
  return emails;
}

export function createCalendarSyncState(eventId) {
  return {
    eventId,
    status: 'PENDING',
    providerEventId: null,
    lastError: null,
  };
}

export function markCalendarSyncOutcome(state, outcome = {}) {
  return {
    ...state,
    providerEventId: outcome.providerEventId ?? state.providerEventId ?? null,
    status: outcome.status ?? state.status ?? 'PENDING',
    lastError: outcome.error ? { kind: outcome.error.kind, message: outcome.error.message } : outcome.lastError ?? state.lastError ?? null,
  };
}

export function applyCalendarSyncStateToEvent(eventPayload, outcome = {}) {
  return {
    ...eventPayload,
    googleCalendarEventId: outcome.providerEventId || eventPayload.googleCalendarEventId || null,
    calendarSyncStatus: outcome.status || eventPayload.calendarSyncStatus || 'PENDING',
    calendarSyncError: outcome.error ? outcome.error.message : eventPayload.calendarSyncError || null,
  };
}

function normalizeAttendeeEmails(attendeeEmails = []) {
  return (attendeeEmails || [])
    .filter(Boolean)
    .map((email) => (typeof email === 'string' ? email : email.email))
    .map((email) => String(email).trim())
    .filter(Boolean);
}

function validateAttendeeEmails(attendeeEmails = []) {
  const normalized = normalizeAttendeeEmails(attendeeEmails);
  const invalid = normalized.filter((email) => !EMAIL_REGEX.test(email));
  if (invalid.length) {
    throw new Error(`Invalid attendee email${invalid.length > 1 ? 's' : ''}: ${invalid.join(', ')}. Fix the attendee list before retrying.`);
  }
  return normalized;
}

// Redirects real invites to a single test address when CALENDAR_INVITE_TEST_EMAIL is set,
// or falls back to a safe default address when running local/test flows.
function resolveAttendees(attendeeEmails) {
  if (config.calendarInviteTestEmail) {
    return [config.calendarInviteTestEmail];
  }
  if (process.env.NODE_ENV !== 'production') {
    return ['test@example.com'];
  }
  return attendeeEmails;
}

function buildProviderEventId(eventId) {
  return eventId ? `uc-ats-${eventId}` : null;
}

export function isCalendarConfigured() {
  return Boolean(config.googleCalendarId);
}

export function classifyCalendarError(error) {
  const message = error?.message || '';
  const lowerMessage = message.toLowerCase();
  const status = error?.code || error?.response?.status;
  if (lowerMessage.includes('invalid_grant') || lowerMessage.includes('unauthorized') || status === 401 || status === 403) {
    return { kind: 'oauth', message: 'Google Calendar authentication failed. Reconnect the service account or refresh credentials before retrying.' };
  }
  if (lowerMessage.includes('quota') || status === 429) {
    return { kind: 'quota', message: 'Google Calendar quota has been exceeded. Retry later or reduce the invitation volume.' };
  }
  if ((lowerMessage.includes('invalid') && lowerMessage.includes('email')) || lowerMessage.includes('malformed')) {
    return { kind: 'malformed-email', message: 'One or more attendee emails are invalid. Fix the invitee list before retrying.' };
  }
  return { kind: 'provider', message: error?.message || 'Google Calendar failed to process the invite. Retry the sync after confirming provider availability.' };
}

// Creates a Google Calendar event and invites attendeeEmails. Returns the created event's ID
// (store this on the Events row so future updates patch it instead of duplicating it), or null
// if GOOGLE_CALENDAR_ID isn't configured yet.
export async function createCalendarEvent(eventDetails, attendeeEmails, options = {}) {
  if (!isCalendarConfigured() && !options.calendarClient) {
    console.warn('[Calendar] GOOGLE_CALENDAR_ID not set — skipping calendar invite creation.');
    return null;
  }

  const calendar = options.calendarClient || await getCalendarClient();
  const providerEventId = buildProviderEventId(options.eventId || eventDetails?.id || eventDetails?.eventId);
  const validatedAttendees = validateAttendeeEmails(attendeeEmails);
  const resolvedAttendees = resolveAttendees(validatedAttendees);

  try {
    const res = await calendar.events.insert({
      calendarId: config.googleCalendarId,
      sendUpdates: 'all',
      requestBody: buildCalendarEventResource(eventDetails, resolvedAttendees, providerEventId),
    });
    return res.data.id;
  } catch (error) {
    if (isDuplicateError(error) && providerEventId) {
      const res = await calendar.events.patch({
        calendarId: config.googleCalendarId,
        eventId: providerEventId,
        sendUpdates: 'all',
        requestBody: buildCalendarEventResource(eventDetails, resolvedAttendees, providerEventId),
      });
      return res.data.id;
    }
    throw error;
  }
}

// Patches an existing Google Calendar event in place so already-invited attendees see an update
// rather than a duplicate invite. Falls back to creating a new event if the stored ID no longer
// exists on the calendar (e.g. someone deleted it directly in Google Calendar).
export async function updateCalendarEvent(calendarEventId, eventDetails, attendeeEmails, options = {}) {
  if (!isCalendarConfigured() && !options.calendarClient) {
    console.warn('[Calendar] GOOGLE_CALENDAR_ID not set — skipping calendar invite update.');
    return null;
  }

  const calendar = options.calendarClient || await getCalendarClient();
  const validatedAttendees = validateAttendeeEmails(attendeeEmails);
  const resolvedAttendees = resolveAttendees(validatedAttendees);

  try {
    const res = await calendar.events.patch({
      calendarId: config.googleCalendarId,
      eventId: calendarEventId,
      sendUpdates: 'all',
      requestBody: buildCalendarEventResource(eventDetails, resolvedAttendees),
    });
    return res.data.id;
  } catch (error) {
    if (isGoneError(error)) {
      console.warn(`[Calendar] Event ${calendarEventId} no longer exists on the calendar — recreating.`);
      return createCalendarEvent(eventDetails, attendeeEmails, options);
    }
    throw error;
  }
}

// Cancels a Google Calendar event (notifies attendees it's off). Safe to call with an ID that's
// already gone.
export async function cancelCalendarEvent(calendarEventId) {
  if (!isCalendarConfigured() || !calendarEventId) return;

  const calendar = await getCalendarClient();
  try {
    await calendar.events.delete({
      calendarId: config.googleCalendarId,
      eventId: calendarEventId,
      sendUpdates: 'all',
    });
  } catch (error) {
    if (!isGoneError(error)) {
      throw error;
    }
  }
}

function isGoneError(error) {
  const status = error.code || error.response?.status;
  return status === 404 || status === 410;
}

function isDuplicateError(error) {
  const status = error.code || error.response?.status;
  const message = String(error.message || '').toLowerCase();
  return status === 409 || message.includes('already exists') || message.includes('duplicate');
}
