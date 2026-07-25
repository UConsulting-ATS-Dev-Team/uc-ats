import prisma from '../prismaClient.js';
import config from '../config.js';
import {
  deleteEventById,
  insertEventWithId,
  isCalendarConfigured,
  patchEventById,
  resolveAttendees
} from './google/calendar.js';
import {
  buildInterviewEventId,
  buildInterviewEventPayload,
  collectAssignedUserIds,
  describeCalendarError,
  diffAttendees,
  partitionAttendees,
  upsertCalendarEvent,
  withCalendarRetry
} from '../utils/interviewCalendarUtils.js';

// Only ATS members/admins can be interviewers; a user without one of these roles is no longer an
// active interviewer and must not receive an invite.
const INTERVIEWER_ROLES = ['MEMBER', 'ADMIN'];

// Resolves the authoritative interviewer roster for an interview: every assigned user that still
// has an interviewer role and a usable email address.
export async function resolveInterviewAttendees(interview) {
  const userIds = collectAssignedUserIds(interview);
  if (userIds.length === 0) return { attendees: [], invalid: [] };

  const users = await prisma.user.findMany({
    where: { id: { in: userIds }, role: { in: INTERVIEWER_ROLES } },
    select: { id: true, email: true, fullName: true }
  });

  return partitionAttendees(users);
}

// Creates or updates the Google Calendar event for an interview and records the result on the
// interview row. Never throws: callers treat calendar sync as best-effort and surface
// `calendarSyncError` to admins.
export async function syncInterviewCalendarEvent(interviewId, { reason = 'update' } = {}) {
  const interview = await prisma.interview.findUnique({
    where: { id: interviewId },
    include: { cycle: true, assignments: true }
  });

  if (!interview) {
    return { status: 'NOT_SYNCED', error: 'Interview not found' };
  }

  if (!isCalendarConfigured()) {
    return persistSyncResult(interview, {
      status: 'NOT_SYNCED',
      error: 'Google Calendar is not configured. Set GOOGLE_CALENDAR_ID and share that calendar with the ATS service account to send interviewer invites.'
    });
  }

  const { attendees, invalid } = await resolveInterviewAttendees(interview);
  const changes = diffAttendees(interview.calendarAttendees, attendees);

  if (attendees.length === 0 && !interview.calendarEventId) {
    return persistSyncResult(interview, {
      status: 'NOT_SYNCED',
      error: invalid.length > 0
        ? `No interviewer with a valid email is assigned yet. Fix the email for: ${invalid.join(', ')}.`
        : null,
      changes
    });
  }

  let payload;
  try {
    payload = buildInterviewEventPayload({
      interview,
      attendeeEmails: resolveAttendees(attendees),
      rosterSize: attendees.length,
      clientUrl: config.clientUrl
    });
  } catch (error) {
    return persistSyncResult(interview, { status: 'FAILED', error: error.message, changes });
  }

  const eventId = buildInterviewEventId(interview.id);

  try {
    const event = await withCalendarRetry(() => upsertCalendarEvent({
      eventId,
      storedEventId: interview.calendarEventId,
      payload,
      insertEvent: insertEventWithId,
      patchEvent: patchEventById
    }));
    console.log(
      `[InterviewCalendar] Synced interview ${interview.id} (${reason}): ${changes.added.length} invited, ${changes.removed.length} removed, ${attendees.length} total attendee(s).`
    );
    return persistSyncResult(interview, {
      status: 'SYNCED',
      calendarEventId: event.id,
      attendees,
      error: invalid.length > 0
        ? `Invite sent, but these interviewers have no valid email and were skipped: ${invalid.join(', ')}.`
        : null,
      changes
    });
  } catch (error) {
    const message = describeCalendarError(error);
    console.error(`[InterviewCalendar] Failed to sync interview ${interview.id}:`, error?.message);
    return persistSyncResult(interview, { status: 'FAILED', error: message, changes });
  }
}

// Cancels the interview's calendar event (Google notifies attendees) and clears the stored ID.
export async function cancelInterviewCalendarEvent(interviewId) {
  const interview = await prisma.interview.findUnique({
    where: { id: interviewId },
    select: { id: true, calendarEventId: true }
  });

  if (!interview?.calendarEventId || !isCalendarConfigured()) return { status: 'NOT_SYNCED' };

  try {
    await withCalendarRetry(() => deleteEventById(interview.calendarEventId));
  } catch (error) {
    console.error(`[InterviewCalendar] Failed to cancel event for interview ${interviewId}:`, error?.message);
    return { status: 'FAILED', error: describeCalendarError(error) };
  }

  await updateInterviewSyncFields(interviewId, {
    calendarEventId: null,
    calendarAttendees: [],
    calendarSyncStatus: 'CANCELLED',
    calendarSyncError: null,
    calendarSyncedAt: new Date()
  });

  return { status: 'CANCELLED' };
}

async function persistSyncResult(interview, { status, calendarEventId, attendees, error = null, changes }) {
  const data = {
    calendarSyncStatus: status,
    calendarSyncError: error,
    calendarSyncedAt: status === 'SYNCED' ? new Date() : interview.calendarSyncedAt
  };
  if (calendarEventId !== undefined) data.calendarEventId = calendarEventId;
  if (attendees !== undefined) data.calendarAttendees = attendees;

  await updateInterviewSyncFields(interview.id, data);

  return {
    status,
    error,
    calendarEventId: calendarEventId ?? interview.calendarEventId ?? null,
    invited: changes?.added || [],
    removed: changes?.removed || []
  };
}

// The calendar columns are additive, so a server running ahead of its migration should degrade to
// "not synced" rather than break interview creation.
async function updateInterviewSyncFields(interviewId, data) {
  try {
    await prisma.interview.update({ where: { id: interviewId }, data });
  } catch (updateError) {
    if (updateError?.code === 'P2021' || updateError?.code === 'P2022') {
      console.warn('[InterviewCalendar] Calendar sync columns are missing — run prisma migrate deploy.');
      return;
    }
    throw updateError;
  }
}
