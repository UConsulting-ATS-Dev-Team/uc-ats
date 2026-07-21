import prisma from '../../prismaClient.js';
import { createCalendarEvent, updateCalendarEvent } from './calendar.js';

// Resolves who should receive the Google Calendar invite for an event: every ADMIN (always),
// whichever MEMBERs were manually selected as invitees, and any candidate who has RSVP'd.
export async function getEventAttendeeEmails(eventId) {
  const [admins, invitees, rsvps] = await Promise.all([
    prisma.user.findMany({ where: { role: 'ADMIN' }, select: { email: true } }),
    prisma.eventInvitee.findMany({ where: { eventId }, select: { user: { select: { email: true } } } }),
    prisma.eventRsvp.findMany({ where: { eventId }, select: { candidate: { select: { email: true } } } })
  ]);
  const emails = new Set([
    ...admins.map((a) => a.email),
    ...invitees.map((i) => i.user.email),
    ...rsvps.map((r) => r.candidate.email)
  ]);
  return [...emails];
}

// Filters a list of candidate invitee IDs down to real MEMBER-role users, so candidates/admins
// can't be added to the invitee join table (admins are already always invited).
export async function resolveMemberInviteeIds(memberInviteeIds) {
  if (!Array.isArray(memberInviteeIds) || memberInviteeIds.length === 0) return [];
  const members = await prisma.user.findMany({
    where: { id: { in: memberInviteeIds }, role: 'MEMBER' },
    select: { id: true }
  });
  return members.map((m) => m.id);
}

export async function setEventInvitees(eventId, memberInviteeIds) {
  const validIds = await resolveMemberInviteeIds(memberInviteeIds);
  await prisma.$transaction([
    prisma.eventInvitee.deleteMany({ where: { eventId } }),
    ...(validIds.length
      ? [prisma.eventInvitee.createMany({ data: validIds.map((userId) => ({ eventId, userId })) })]
      : [])
  ]);
  return validIds;
}

// Creates or updates the Google Calendar invite for an event. Never throws — a calendar/API
// failure shouldn't block event create/update/RSVP sync; callers get back
// { googleCalendarEventId, calendarError }.
export async function syncEventCalendarInvite(event) {
  try {
    const [attendeeEmails, cycle] = await Promise.all([
      getEventAttendeeEmails(event.id),
      prisma.recruitingCycle.findUnique({ where: { id: event.cycleId }, select: { name: true } })
    ]);

    const eventDetails = {
      eventName: event.eventName,
      eventLocation: event.eventLocation,
      eventStartDate: event.eventStartDate,
      eventEndDate: event.eventEndDate,
      cycleName: cycle?.name
    };

    const googleCalendarEventId = event.googleCalendarEventId
      ? await updateCalendarEvent(event.googleCalendarEventId, eventDetails, attendeeEmails)
      : await createCalendarEvent(eventDetails, attendeeEmails);

    if (googleCalendarEventId && googleCalendarEventId !== event.googleCalendarEventId) {
      await prisma.events.update({ where: { id: event.id }, data: { googleCalendarEventId } });
    }

    return { googleCalendarEventId, attendeeCount: attendeeEmails.length };
  } catch (error) {
    console.error(`[Calendar] Failed to sync invite for event ${event.id}:`, error);
    return { googleCalendarEventId: event.googleCalendarEventId || null, calendarError: error.message };
  }
}
