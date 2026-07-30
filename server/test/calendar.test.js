import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildCalendarEventResource,
  createCalendarEvent,
  updateCalendarEvent,
  classifyCalendarError,
  buildCalendarAudienceEmails,
} from '../src/services/google/calendar.js';

test('createCalendarEvent uses a deterministic provider id and sends the request body', async () => {
  let inserted;
  const calendarClient = {
    events: {
      insert: async (payload) => {
        inserted = payload;
        return { data: { id: 'provider-event-id' } };
      },
    },
  };

  const result = await createCalendarEvent(
    {
      eventName: 'Interview Day',
      eventLocation: 'Zoom',
      eventStartDate: '2026-08-01T12:00:00.000Z',
      eventEndDate: '2026-08-01T13:00:00.000Z',
      cycleName: 'Fall 2026',
    },
    ['admin@example.com'],
    { calendarClient, eventId: 'event-123' }
  );

  assert.equal(result, 'provider-event-id');
  assert.equal(inserted.requestBody.id, 'uc-ats-event-123');
  assert.equal(inserted.requestBody.summary, 'Interview Day');
  assert.deepEqual(inserted.requestBody.attendees, [{ email: 'test@example.com' }]);
});

test('createCalendarEvent retries as an update when the provider reports a duplicate id', async () => {
  const calls = [];
  const calendarClient = {
    events: {
      insert: async () => {
        calls.push('insert');
        const error = new Error('duplicate event');
        error.code = 409;
        throw error;
      },
      patch: async (payload) => {
        calls.push('patch');
        assert.equal(payload.eventId, 'uc-ats-event-123');
        return { data: { id: 'provider-event-id' } };
      },
    },
  };

  const result = await createCalendarEvent(
    {
      eventName: 'Interview Day',
      eventStartDate: '2026-08-01T12:00:00.000Z',
      eventEndDate: '2026-08-01T13:00:00.000Z',
    },
    ['admin@example.com'],
    { calendarClient, eventId: 'event-123' }
  );

  assert.equal(result, 'provider-event-id');
  assert.deepEqual(calls, ['insert', 'patch']);
});

test('buildCalendarAudienceEmails includes admins and current invitees without duplicates', () => {
  const audience = buildCalendarAudienceEmails(
    ['admin@example.com', 'shared@example.com'],
    ['member@example.com', 'shared@example.com', 'member@example.com']
  );

  assert.deepEqual(audience, ['admin@example.com', 'shared@example.com', 'member@example.com']);
});

test('updateCalendarEvent sends the latest attendee list so removed invitees are dropped', async () => {
  let patched;
  const calendarClient = {
    events: {
      patch: async (payload) => {
        patched = payload;
        return { data: { id: 'provider-event-id' } };
      },
    },
  };

  await updateCalendarEvent(
    'provider-event-id',
    {
      eventName: 'Updated event',
      eventStartDate: '2026-08-01T12:00:00.000Z',
      eventEndDate: '2026-08-01T13:00:00.000Z',
    },
    ['member@example.com'],
    { calendarClient }
  );

  assert.ok(patched);
  assert.deepEqual(patched.requestBody.attendees, [{ email: 'test@example.com' }]);
});

test('createCalendarEvent rejects malformed attendee emails with an actionable message', async () => {
  const calendarClient = {
    events: {
      insert: async () => ({ data: { id: 'provider-event-id' } }),
    },
  };

  await assert.rejects(
    () =>
      createCalendarEvent(
        {
          eventName: 'Interview Day',
          eventStartDate: '2026-08-01T12:00:00.000Z',
          eventEndDate: '2026-08-01T13:00:00.000Z',
        },
        ['not-an-email'],
        { calendarClient }
      ),
    /Invalid attendee email/i
  );
});

test('classifyCalendarError returns the correct provider-facing category', () => {
  assert.equal(classifyCalendarError({ code: 401, message: 'invalid_grant' }).kind, 'oauth');
  assert.equal(classifyCalendarError({ code: 429, message: 'quota exceeded' }).kind, 'quota');
  assert.equal(classifyCalendarError({ message: 'Invalid email address' }).kind, 'malformed-email');
  assert.equal(classifyCalendarError({ code: 500, message: 'provider blew up' }).kind, 'provider');
});
