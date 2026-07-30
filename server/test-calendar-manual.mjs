import { google } from 'googleapis';
import { getGoogleAuthClient } from './src/services/google/auth.js';
import config from './src/config.js';

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMED OUT after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

console.log('GOOGLE_CALENDAR_ID:', config.googleCalendarId);
console.log('CALENDAR_INVITE_TEST_EMAIL:', config.calendarInviteTestEmail);
console.log('GOOGLE_CLOUD_KEY_PATH (resolved):', config.gCloudKeyPath);

console.log('\n--- Step 1: getGoogleAuthClient() ---');
const authClient = await withTimeout(getGoogleAuthClient(), 15000, 'getGoogleAuthClient()');
console.log('OK — got auth client. Type:', authClient.constructor?.name);

console.log('\n--- Step 2: fetch an access token directly (isolates auth vs API call) ---');
await withTimeout(authClient.getAccessToken(), 15000, 'authClient.getAccessToken()');
console.log('OK — got a Google Calendar access token for the service account.');

console.log('\n--- Step 3: build calendar client ---');
const calendar = google.calendar({ version: 'v3', auth: authClient });
console.log('OK — calendar client built.');

console.log('\n--- Step 4: list calendars the service account can see (read-only, no invite sent) ---');
const list = await withTimeout(
  calendar.calendarList.list({ maxResults: 10 }),
  15000,
  'calendar.calendarList.list()'
);
console.log('OK — calendars visible to service account:', list.data.items?.map((c) => c.id) || []);

console.log('\n--- Step 5: get target calendar metadata (confirms sharing worked) ---');
const calMeta = await withTimeout(
  calendar.calendars.get({ calendarId: config.googleCalendarId }),
  15000,
  'calendar.calendars.get()'
);
console.log('OK — target calendar summary:', calMeta.data.summary);

console.log('\n--- Step 6: insert a test event WITHOUT attendees (isolates invite-sending as the culprit) ---');
const noAttendeeEvent = await withTimeout(
  calendar.events.insert({
    calendarId: config.googleCalendarId,
    requestBody: {
      summary: '[TEST - safe to ignore] no attendees',
      start: { dateTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), timeZone: 'America/Los_Angeles' },
      end: { dateTime: new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString(), timeZone: 'America/Los_Angeles' },
    },
  }),
  20000,
  'calendar.events.insert() WITHOUT attendees'
);
console.log('OK — created event without attendees, id:', noAttendeeEvent.data.id);

console.log('\n--- Step 7: insert a test event WITH an attendee + sendUpdates:"all" (the real behavior) ---');
const withAttendeeEvent = await withTimeout(
  calendar.events.insert({
    calendarId: config.googleCalendarId,
    sendUpdates: 'all',
    requestBody: {
      summary: '[TEST - safe to ignore] with attendee',
      start: { dateTime: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), timeZone: 'America/Los_Angeles' },
      end: { dateTime: new Date(Date.now() + 25 * 60 * 60 * 1000).toISOString(), timeZone: 'America/Los_Angeles' },
      attendees: [{ email: config.calendarInviteTestEmail || 'test@example.com' }],
    },
  }),
  20000,
  'calendar.events.insert() WITH attendees + sendUpdates:all'
);
console.log('OK — created event with attendee, id:', withAttendeeEvent.data.id);

console.log('\n--- Cleanup: cancelling both test events ---');
await withTimeout(
  calendar.events.delete({ calendarId: config.googleCalendarId, eventId: noAttendeeEvent.data.id, sendUpdates: 'all' }),
  15000,
  'cleanup delete #1'
);
await withTimeout(
  calendar.events.delete({ calendarId: config.googleCalendarId, eventId: withAttendeeEvent.data.id, sendUpdates: 'all' }),
  15000,
  'cleanup delete #2'
);

console.log('\nALL STEPS PASSED.');
process.exit(0);
