import { google } from 'googleapis';
import { getGoogleAuthClient } from './auth.js';
import config from '../../config.js';

export const TIMEZONE = 'America/Los_Angeles';

let calendarClient;

async function getCalendarClient() {
  if (!calendarClient) {
    const authClient = await getGoogleAuthClient();
    calendarClient = google.calendar({ version: 'v3', auth: authClient });
  }
  return calendarClient;
}

function buildEventResource({ eventName, eventLocation, eventStartDate, eventEndDate, cycleName }, attendeeEmails) {
  const description = `UConsulting Event: ${eventName}${cycleName ? `\nCycle: ${cycleName}` : ''}\n\nThis is a UConsulting recruitment event. You're receiving this invite because you're a relevant UConsulting member or admin.`;

  return {
    summary: eventName,
    location: eventLocation || undefined,
    description,
    start: { dateTime: new Date(eventStartDate).toISOString(), timeZone: TIMEZONE },
    end: { dateTime: new Date(eventEndDate).toISOString(), timeZone: TIMEZONE },
    attendees: attendeeEmails.map((email) => ({ email })),
  };
}

// Redirects real invites to a single test address when CALENDAR_INVITE_TEST_EMAIL is set,
// so this can be exercised safely before it emails the whole team.
export function resolveAttendees(attendeeEmails) {
  if (config.calendarInviteTestEmail) {
    console.warn(
      `[Calendar] TEST MODE active — redirecting ${attendeeEmails.length} real invite(s) to ${config.calendarInviteTestEmail}. Unset CALENDAR_INVITE_TEST_EMAIL to send to real members/admins.`
    );
    return [config.calendarInviteTestEmail];
  }
  return attendeeEmails;
}

export function isCalendarConfigured() {
  return Boolean(config.googleCalendarId);
}

// Creates a Google Calendar event and invites attendeeEmails. Returns the created event's ID
// (store this on the Events row so future updates patch it instead of duplicating it), or null
// if GOOGLE_CALENDAR_ID isn't configured yet.
export async function createCalendarEvent(eventDetails, attendeeEmails) {
  if (!isCalendarConfigured()) {
    console.warn('[Calendar] GOOGLE_CALENDAR_ID not set — skipping calendar invite creation.');
    return null;
  }

  const calendar = await getCalendarClient();
  const res = await calendar.events.insert({
    calendarId: config.googleCalendarId,
    sendUpdates: 'all',
    requestBody: buildEventResource(eventDetails, resolveAttendees(attendeeEmails)),
  });
  return res.data.id;
}

// Patches an existing Google Calendar event in place so already-invited attendees see an update
// rather than a duplicate invite. Falls back to creating a new event if the stored ID no longer
// exists on the calendar (e.g. someone deleted it directly in Google Calendar).
export async function updateCalendarEvent(calendarEventId, eventDetails, attendeeEmails) {
  if (!isCalendarConfigured()) {
    console.warn('[Calendar] GOOGLE_CALENDAR_ID not set — skipping calendar invite update.');
    return null;
  }

  const calendar = await getCalendarClient();
  try {
    const res = await calendar.events.patch({
      calendarId: config.googleCalendarId,
      eventId: calendarEventId,
      sendUpdates: 'all',
      requestBody: buildEventResource(eventDetails, resolveAttendees(attendeeEmails)),
    });
    return res.data.id;
  } catch (error) {
    if (isGoneError(error)) {
      console.warn(`[Calendar] Event ${calendarEventId} no longer exists on the calendar — recreating.`);
      return createCalendarEvent(eventDetails, attendeeEmails);
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
  const status = error?.code || error?.response?.status;
  return status === 404 || status === 410;
}

// Inserts an event using a caller-supplied event ID so repeated calls for the same record can
// never create duplicates: Google rejects a second insert with 409 Conflict.
export async function insertEventWithId(eventId, requestBody) {
  const calendar = await getCalendarClient();
  const res = await calendar.events.insert({
    calendarId: config.googleCalendarId,
    eventId,
    sendUpdates: 'all',
    requestBody: { ...requestBody, id: eventId },
  });
  return res.data;
}

// Patches an event in place. Attendees supplied here replace the existing attendee list, so
// removed interviewers get a cancellation and remaining ones keep their original invite.
export async function patchEventById(eventId, requestBody) {
  const calendar = await getCalendarClient();
  const res = await calendar.events.patch({
    calendarId: config.googleCalendarId,
    eventId,
    sendUpdates: 'all',
    requestBody,
  });
  return res.data;
}

export async function deleteEventById(eventId) {
  const calendar = await getCalendarClient();
  try {
    await calendar.events.delete({
      calendarId: config.googleCalendarId,
      eventId,
      sendUpdates: 'all',
    });
  } catch (error) {
    if (!isGoneError(error)) throw error;
  }
}
