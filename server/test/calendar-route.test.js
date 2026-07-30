import test from 'node:test';
import assert from 'node:assert/strict';

import { createCalendarSyncState, markCalendarSyncOutcome, applyCalendarSyncStateToEvent } from '../src/services/google/calendar.js';

test('sync state transitions from pending to synced and failed', () => {
  const state = createCalendarSyncState('event-1');
  assert.equal(state.status, 'PENDING');

  const synced = markCalendarSyncOutcome(state, { providerEventId: 'provider-1', status: 'SYNCED' });
  assert.equal(synced.status, 'SYNCED');
  assert.equal(synced.providerEventId, 'provider-1');

  const failed = markCalendarSyncOutcome(synced, {
    status: 'FAILED',
    error: { kind: 'quota', message: 'quota exceeded' },
  });
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.lastError?.kind, 'quota');
});

test('applyCalendarSyncStateToEvent preserves the provider id and status on the event payload', () => {
  const payload = applyCalendarSyncStateToEvent(
    { googleCalendarEventId: null, calendarSyncStatus: null, calendarSyncError: null },
    { providerEventId: 'provider-2', status: 'SYNCED' }
  );

  assert.equal(payload.googleCalendarEventId, 'provider-2');
  assert.equal(payload.calendarSyncStatus, 'SYNCED');
  assert.equal(payload.calendarSyncError, null);
});
