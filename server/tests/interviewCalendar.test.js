import { test } from 'vitest';
import assert from 'node:assert/strict';

import {
  buildInterviewEventId,
  buildInterviewEventPayload,
  collectAssignedUserIds,
  describeCalendarError,
  diffAttendees,
  isTransientCalendarError,
  partitionAttendees,
  upsertCalendarEvent,
  withCalendarRetry
} from '../src/utils/interviewCalendarUtils.js';

const INTERVIEW = {
  id: '3f1c2b7e-9d4a-4d1e-8f52-6a0b1c2d3e4f',
  title: 'Round 1 – Session A',
  interviewType: 'ROUND_ONE',
  // 2026-02-14 09:00 America/Los_Angeles
  startDate: new Date('2026-02-14T17:00:00.000Z'),
  endDate: new Date('2026-02-14T19:30:00.000Z'),
  location: 'Anderson Hall 204',
  dresscode: 'Business formal',
  description: JSON.stringify({
    memberGroups: [{ id: 'g1', memberIds: ['user-1', 'user-2'], notes: 'internal only' }],
    applicationGroups: [{ id: 'a1', applicationIds: ['app-1'] }]
  }),
  cycle: { name: 'Winter 2026' }
};

test('event payload uses timezone-correct times, location and sanitized session details', () => {
  const payload = buildInterviewEventPayload({
    interview: INTERVIEW,
    attendeeEmails: ['a@ucla.edu', 'b@ucla.edu'],
    clientUrl: 'https://uconsultingats.com'
  });

  assert.equal(payload.summary, 'UConsulting Round 1: Round 1 – Session A (Winter 2026)');
  assert.equal(payload.location, 'Anderson Hall 204');
  assert.deepEqual(payload.start, { dateTime: '2026-02-14T17:00:00.000Z', timeZone: 'America/Los_Angeles' });
  assert.deepEqual(payload.end, { dateTime: '2026-02-14T19:30:00.000Z', timeZone: 'America/Los_Angeles' });
  assert.deepEqual(payload.attendees, [{ email: 'a@ucla.edu' }, { email: 'b@ucla.edu' }]);
  assert.match(payload.description, /Session ID: 3f1c2b7e-9d4a-4d1e-8f52-6a0b1c2d3e4f/);
  assert.match(payload.description, /Dress code: Business formal/);
  assert.match(payload.description, /Interviewers invited: 2/);
  assert.match(payload.description, /https:\/\/uconsultingats\.com\/admin\/assigned-interviews/);
  // The description column stores internal JSON config; none of it may leak into the invite.
  assert.doesNotMatch(payload.description, /memberIds|applicationGroups|internal only/);
});

test('event payload advertises a video link instead of a room when the location is a URL', () => {
  const payload = buildInterviewEventPayload({
    interview: { ...INTERVIEW, location: 'https://zoom.us/j/123456' },
    attendeeEmails: []
  });

  assert.equal(payload.location, 'https://zoom.us/j/123456');
  assert.match(payload.description, /Video link: https:\/\/zoom\.us\/j\/123456/);
});

test('event payload reports the real roster size when invites are redirected to a test address', () => {
  const payload = buildInterviewEventPayload({
    interview: INTERVIEW,
    attendeeEmails: ['qa@example.com'],
    rosterSize: 2
  });

  assert.deepEqual(payload.attendees, [{ email: 'qa@example.com' }]);
  assert.match(payload.description, /Interviewers invited: 2/);
});

test('event payload rejects missing or inverted interview times', () => {
  assert.throws(
    () => buildInterviewEventPayload({ interview: { ...INTERVIEW, endDate: null }, attendeeEmails: [] }),
    /missing a start or end date/
  );
  assert.throws(
    () => buildInterviewEventPayload({
      interview: { ...INTERVIEW, endDate: new Date('2026-02-14T16:00:00.000Z') },
      attendeeEmails: []
    }),
    /end date must be after/
  );
});

test('roster is the deduped union of assignment rows and the member groups config', () => {
  const ids = collectAssignedUserIds({
    ...INTERVIEW,
    assignments: [{ userId: 'user-2' }, { userId: 'user-3' }]
  });

  assert.deepEqual(ids.sort(), ['user-1', 'user-2', 'user-3']);
});

test('roster ignores unparsable config and never invents attendees', () => {
  assert.deepEqual(collectAssignedUserIds({ description: 'plain text notes' }), []);
  assert.deepEqual(collectAssignedUserIds({}), []);
});

test('attendees are normalized, deduped and malformed emails are reported for the admin', () => {
  const { attendees, invalid } = partitionAttendees([
    { id: 'u1', fullName: 'Ada Lovelace', email: 'Ada@UCLA.edu' },
    { id: 'u2', fullName: 'Alan Turing', email: 'ada@ucla.edu ' },
    { id: 'u3', fullName: 'Grace Hopper', email: 'not-an-email' },
    { id: 'u4', fullName: 'Katherine Johnson', email: null }
  ]);

  assert.deepEqual(attendees, ['ada@ucla.edu']);
  assert.deepEqual(invalid, ['Grace Hopper', 'Katherine Johnson']);
});

test('attendee diffing reports added and removed interviewers', () => {
  const diff = diffAttendees(['a@ucla.edu', 'b@ucla.edu'], ['B@ucla.edu', 'c@ucla.edu']);

  assert.deepEqual(diff.added, ['c@ucla.edu']);
  assert.deepEqual(diff.removed, ['a@ucla.edu']);
  assert.deepEqual(diff.unchanged, ['b@ucla.edu']);
});

test('event ID is deterministic and uses only characters Google accepts', () => {
  const eventId = buildInterviewEventId(INTERVIEW.id);

  assert.equal(eventId, buildInterviewEventId(INTERVIEW.id));
  assert.match(eventId, /^[0-9a-v]+$/);
  assert.notEqual(eventId, buildInterviewEventId('11111111-2222-3333-4444-555555555555'));
});

function fakeCalendar({ existingIds = [], missingIds = [] } = {}) {
  const calls = { insert: [], patch: [] };
  return {
    calls,
    insertEvent: async (eventId, payload) => {
      calls.insert.push({ eventId, payload });
      if (existingIds.includes(eventId)) throw Object.assign(new Error('duplicate'), { code: 409 });
      return { id: eventId };
    },
    patchEvent: async (eventId, payload) => {
      calls.patch.push({ eventId, payload });
      if (missingIds.includes(eventId)) throw Object.assign(new Error('gone'), { code: 404 });
      return { id: eventId };
    }
  };
}

test('first sync inserts the event under the deterministic ID', async () => {
  const calendar = fakeCalendar();

  const event = await upsertCalendarEvent({
    eventId: 'ucats123',
    storedEventId: null,
    payload: { summary: 'x' },
    insertEvent: calendar.insertEvent,
    patchEvent: calendar.patchEvent
  });

  assert.equal(event.id, 'ucats123');
  assert.equal(calendar.calls.insert.length, 1);
  assert.equal(calendar.calls.patch.length, 0);
});

test('later syncs patch the stored event instead of creating a duplicate', async () => {
  const calendar = fakeCalendar();

  const event = await upsertCalendarEvent({
    eventId: 'ucats123',
    storedEventId: 'ucats123',
    payload: { summary: 'x' },
    insertEvent: calendar.insertEvent,
    patchEvent: calendar.patchEvent
  });

  assert.equal(event.id, 'ucats123');
  assert.equal(calendar.calls.insert.length, 0);
  assert.equal(calendar.calls.patch.length, 1);
});

test('a retried create after a lost response patches the existing event (409) rather than duplicating', async () => {
  const calendar = fakeCalendar({ existingIds: ['ucats123'] });

  const event = await upsertCalendarEvent({
    eventId: 'ucats123',
    storedEventId: null,
    payload: { summary: 'x' },
    insertEvent: calendar.insertEvent,
    patchEvent: calendar.patchEvent
  });

  assert.equal(event.id, 'ucats123');
  assert.equal(calendar.calls.insert.length, 1);
  assert.deepEqual(calendar.calls.patch.map((c) => c.eventId), ['ucats123']);
});

test('an event deleted directly in Google Calendar is recreated', async () => {
  const calendar = fakeCalendar({ missingIds: ['ucats123'] });

  const event = await upsertCalendarEvent({
    eventId: 'ucats123',
    storedEventId: 'ucats123',
    payload: { summary: 'x' },
    insertEvent: calendar.insertEvent,
    patchEvent: calendar.patchEvent
  });

  assert.equal(event.id, 'ucats123');
  assert.equal(calendar.calls.patch.length, 1);
  assert.equal(calendar.calls.insert.length, 1);
});

test('transient failures are retried and permanent ones are not', async () => {
  assert.equal(isTransientCalendarError({ code: 503 }), true);
  assert.equal(isTransientCalendarError({ code: 429 }), true);
  assert.equal(isTransientCalendarError({ code: 'ECONNRESET' }), true);
  assert.equal(isTransientCalendarError({ code: 403 }), false);

  let attempts = 0;
  const result = await withCalendarRetry(async () => {
    attempts += 1;
    if (attempts < 3) throw Object.assign(new Error('backend error'), { code: 503 });
    return 'ok';
  }, { sleep: async () => {} });

  assert.equal(result, 'ok');
  assert.equal(attempts, 3);

  let permanentAttempts = 0;
  await assert.rejects(
    withCalendarRetry(async () => {
      permanentAttempts += 1;
      throw Object.assign(new Error('forbidden'), { code: 403 });
    }, { sleep: async () => {} }),
    /forbidden/
  );
  assert.equal(permanentAttempts, 1);
});

test('calendar failures are translated into actionable admin messages', () => {
  assert.match(describeCalendarError({ code: 401, message: 'invalid_grant' }), /re-authorize the service account/);
  assert.match(
    describeCalendarError({ code: 403, message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] }),
    /quota exceeded/i
  );
  assert.match(describeCalendarError({ code: 403, message: 'forbidden' }), /Share GOOGLE_CALENDAR_ID/);
  assert.match(describeCalendarError({ code: 400, message: 'Invalid attendee email' }), /malformed interviewer email/);
});
