import { v5 as uuidv5 } from 'uuid';
import prisma from '../../prismaClient.js';
import {
  createCalendarEvent,
  updateCalendarEvent,
  cancelCalendarEvent,
  isCalendarConfigured,
} from './calendar.js';

const DEFAULT_SLOT_DURATION_MS = 30 * 60 * 1000;
const MAX_RETRY_DELAY_MS = 60 * 60 * 1000;

// Namespace for deriving deterministic MeetingSlot IDs from request fields.
// This lets POST /api/member/meeting-slots recover the original slot on a retry
// without an additional schema column.
const SLOT_ID_NAMESPACE = 'd27a3ee7-fa8f-436d-8757-d872928b45bb';

export function deriveMeetingSlotId({ memberId, location, startTime, endTime, capacity }) {
  const normalized = [
    String(memberId).trim().toLowerCase(),
    String(location).trim().toLowerCase(),
    String(startTime).trim(),
    String(endTime ?? '').trim(),
    Number(capacity),
  ].join(':');
  return uuidv5(normalized, SLOT_ID_NAMESPACE);
}

// Google Calendar event IDs must be base32hex: lowercase a-v and 0-9, 5-1024 chars.
export function deriveCalendarEventId(slotId) {
  if (!slotId) return null;
  const cleaned = String(slotId).toLowerCase().replace(/[^a-v0-9]/g, '');
  if (cleaned.length < 5) return null;
  if (cleaned.length > 1024) return cleaned.slice(0, 1024);
  return cleaned;
}

function buildSlotEventDetails(slot) {
  const start = slot.startTime ? new Date(slot.startTime) : null;
  const end = slot.endTime
    ? new Date(slot.endTime)
    : start
      ? new Date(start.getTime() + DEFAULT_SLOT_DURATION_MS)
      : null;

  return {
    eventName: `Get to Know UC - ${slot.member?.fullName?.trim() || 'UC Consulting Member'}`,
    eventLocation: slot.location,
    eventStartDate: start,
    eventEndDate: end,
  };
}

function getAttendeeEmails(slot) {
  const emails = new Set();
  if (slot.member?.email) {
    emails.add(slot.member.email.toLowerCase());
  }
  for (const signup of slot.signups || []) {
    if (signup?.email) {
      emails.add(signup.email.toLowerCase());
    }
  }
  return Array.from(emails);
}

function nextRetryAt(retryCount) {
  const delay = Math.min(60_000 * 2 ** retryCount, MAX_RETRY_DELAY_MS);
  return new Date(Date.now() + delay);
}

async function persistSyncStatus(slotId, data) {
  return prisma.meetingSlot.update({
    where: { id: slotId },
    data: {
      calendarSyncAt: new Date(),
      ...data,
    },
  });
}

async function recordFailure(slot, error, extra = {}) {
  const retryCount = (slot.calendarRetryCount || 0) + 1;
  const retryAt = nextRetryAt(retryCount - 1);
  const payload = {
    calendarSyncStatus: 'FAILED',
    calendarSyncError: String(error).slice(0, 1000),
    calendarRetryCount: retryCount,
    calendarRetryAt: retryAt,
    ...extra,
  };
  try {
    await persistSyncStatus(slot.id, payload);
  } catch (dbError) {
    console.error(`[meetingSlotCalendar] failed to persist failure for slot ${slot.id}:`, dbError);
  }
  return retryAt;
}

export function calendarSyncResponse(syncResult) {
  const needsWarning = !syncResult.success || (syncResult.status !== 'SYNCED' && syncResult.status !== 'CANCELLED');
  return {
    status: syncResult.status,
    eventId: syncResult.eventId || null,
    error: syncResult.success ? null : syncResult.error,
    warning: needsWarning ? (syncResult.error || `Calendar sync is ${syncResult.status}`) : null,
    retryAt: syncResult.retryAt || null,
  };
}

export async function syncMeetingSlotCalendar(slotId, { force = false } = {}) {
  let slot;
  try {
    slot = await prisma.meetingSlot.findUnique({
      where: { id: slotId },
      include: {
        signups: true,
        member: { select: { fullName: true, email: true } },
      },
    });
  } catch (error) {
    console.error(`[meetingSlotCalendar] failed to load slot ${slotId}:`, error);
    return { success: false, status: 'FAILED', error: error.message || String(error) };
  }

  if (!slot) {
    return { success: false, status: 'FAILED', error: 'Slot not found' };
  }

  if (
    !force &&
    slot.calendarSyncStatus === 'FAILED' &&
    slot.calendarRetryAt &&
    new Date() < new Date(slot.calendarRetryAt)
  ) {
    return {
      success: false,
      status: 'FAILED',
      error: 'Retry backoff active',
      retryAt: slot.calendarRetryAt,
    };
  }

  // Until GOOGLE_CALENDAR_ID is configured, do not call the provider.
  // If the slot already has a provider event ID, the configuration is missing
  // when we need to update/cancel it, so record a failure instead of silently
  // pretending the sync succeeded.
  if (!isCalendarConfigured()) {
    if (slot.calendarEventId) {
      const retryAt = await recordFailure(slot, new Error('Google Calendar is not configured'));
      return {
        success: false,
        status: 'FAILED',
        error: 'Google Calendar is not configured',
        eventId: slot.calendarEventId,
        retryAt,
      };
    }

    await persistSyncStatus(slot.id, {
      calendarSyncStatus: 'NOT_CONFIGURED',
      calendarSyncError: null,
      calendarRetryCount: 0,
      calendarRetryAt: null,
    });
    return { success: true, status: 'NOT_CONFIGURED', eventId: null };
  }

  const eventDetails = buildSlotEventDetails(slot);
  const attendeeEmails = getAttendeeEmails(slot);

  // Derive a deterministic Google-compatible event ID from the slot UUID so that
  // retries are idempotent even when the local state write fails.
  const providerEventId = slot.calendarEventId || deriveCalendarEventId(slot.id);
  if (!providerEventId) {
    return { success: false, status: 'FAILED', error: 'Could not derive a valid calendar event ID' };
  }

  let eventId = null;
  try {
    eventId = await updateCalendarEvent(providerEventId, eventDetails, attendeeEmails);
    if (!eventId) {
      return { success: true, status: 'SYNCED', eventId: providerEventId };
    }
  } catch (providerError) {
    const retryAt = await recordFailure(slot, providerError);
    return { success: false, status: 'FAILED', error: providerError.message || String(providerError), retryAt };
  }

  try {
    await persistSyncStatus(slot.id, {
      calendarEventId: eventId,
      calendarSyncStatus: 'SYNCED',
      calendarSyncError: null,
      calendarRetryCount: 0,
      calendarRetryAt: null,
    });
    return { success: true, status: 'SYNCED', eventId };
  } catch (dbError) {
    // With a deterministic event ID, the provider event can be re-associated on
    // the next retry without creating a duplicate. Record the ID so the retry path
    // can target it.
    const retryAt = await recordFailure(slot, `DB write failure: ${dbError.message || String(dbError)}`, {
      calendarEventId: eventId,
    });
    return { success: false, status: 'FAILED', error: dbError.message || String(dbError), retryAt, eventId };
  }
}

export async function cancelMeetingSlotCalendar(slotId) {
  let slot;
  try {
    slot = await prisma.meetingSlot.findUnique({
      where: { id: slotId },
      include: {
        signups: true,
        member: { select: { fullName: true, email: true } },
      },
    });
  } catch (error) {
    console.error(`[meetingSlotCalendar] failed to load slot ${slotId} for cancellation:`, error);
    return { success: false, status: 'FAILED', error: error.message || String(error) };
  }

  if (!slot) {
    return { success: false, status: 'FAILED', error: 'Slot not found' };
  }

  // A deterministic ID lets us retry cancellation later without losing the handle.
  const providerEventId = slot.calendarEventId || deriveCalendarEventId(slot.id);
  const hasStoredEventId = Boolean(slot.calendarEventId);

  // If we have a stored provider event ID but Calendar is not configured, we cannot
  // verify the cancellation and must not delete the local handle.
  if (hasStoredEventId && !isCalendarConfigured()) {
    const retryAt = await recordFailure(slot, new Error('Google Calendar is not configured'), {
      calendarSyncStatus: 'CANCEL_PENDING',
      calendarEventId: providerEventId,
    });
    return {
      success: false,
      status: 'CANCEL_PENDING',
      error: 'Google Calendar is not configured',
      eventId: providerEventId,
      retryAt,
    };
  }

  if (providerEventId) {
    try {
      await cancelCalendarEvent(providerEventId);
    } catch (providerError) {
      const retryAt = await recordFailure(slot, providerError, {
        calendarSyncStatus: 'CANCEL_PENDING',
        calendarEventId: providerEventId,
      });
      return {
        success: false,
        status: 'CANCEL_PENDING',
        error: providerError.message || String(providerError),
        eventId: providerEventId,
        retryAt,
      };
    }
  }

  try {
    await persistSyncStatus(slot.id, {
      calendarEventId: null,
      calendarSyncStatus: 'CANCELLED',
      calendarSyncError: null,
      calendarRetryCount: 0,
      calendarRetryAt: null,
    });
    return { success: true, status: 'CANCELLED', eventId: null };
  } catch (dbError) {
    const retryAt = await recordFailure(slot, dbError, {
      calendarSyncStatus: 'CANCEL_PENDING',
      calendarEventId: providerEventId,
    });
    return { success: false, status: 'CANCEL_PENDING', error: dbError.message || String(dbError), eventId: providerEventId, retryAt };
  }
}

// Exported for tests.
export { buildSlotEventDetails, getAttendeeEmails, nextRetryAt };
