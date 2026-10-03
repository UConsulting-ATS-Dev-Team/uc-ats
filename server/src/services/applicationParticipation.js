import prisma from '../prismaClient.js';
import { PARTICIPATION_MAX } from './documentRubrics.js';

// What a candidate took part in during one cycle: the cycle's events they
// RSVP'd to or attended (plus Get to Know UC), and the referrals vouching for
// them. Read by Application Detail (`GET /api/applications/:id/events` and
// `/:id/referrals`) and by the review team deliberation card. The participation
// points Staging adds to the documents total are counted here too.
//
// Mechanics only. The callers decide who may see it and check seals first;
// nothing here looks at who is asking.

/**
 * The cycle's events with this candidate's RSVP and attendance on each, plus
 * Get to Know UC as one more attended event when they came to a meeting inside
 * the cycle's dates. One point per attended event.
 *
 * `studentId` is the UID to find the Get to Know UC signup by: the candidate's
 * own, falling back to the application's.
 */
export async function getCycleEventParticipation({
  client = prisma,
  cycleId,
  candidateId,
  studentId,
  cycleStartDate,
  cycleEndDate
}) {
  // No cycle or no candidate means nothing to look up: the RSVP and attendance
  // rows are keyed on the candidate, and there is no Get to Know UC either.
  if (!cycleId || !candidateId) {
    return { events: [], totalPoints: 0 };
  }

  // Get to Know UC only counts inside the cycle's dates. Without a start date there
  // is no telling which meetings belong to this cycle, so none are counted rather
  // than crediting old ones. Without a UID there is no telling whose signup it
  // is, and `studentId: undefined` would be no filter at all, so none either.
  const start = cycleStartDate ? new Date(cycleStartDate) : null;
  const end = cycleEndDate ? new Date(cycleEndDate) : null;
  const lookForMeeting = Boolean(start && studentId);

  // The cycle's events and the Get to Know UC signup, in parallel.
  const [events, meetingAttendance] = await Promise.all([
    client.events.findMany({
      where: { cycleId },
      orderBy: { eventStartDate: 'asc' },
      select: {
        id: true,
        eventName: true,
        eventStartDate: true,
        eventEndDate: true,
        eventLocation: true
      }
    }),
    lookForMeeting
      ? client.meetingSignup.findFirst({
          where: {
            studentId,
            attended: true,
            slot: {
              startTime: {
                gte: start,
                ...(end && { lte: end })
              }
            }
          },
          include: {
            slot: {
              include: {
                member: {
                  select: { fullName: true, profileImage: true }
                }
              }
            }
          }
        })
      : null
  ]);

  // Then the candidate's RSVPs and check-ins for those events, two queries in
  // all, matched up in memory below. This used to ask once per event, 2N
  // queries for N events. Filtering on the event ids, not the cycle, keeps the
  // lookup on the (eventId, candidateId) unique index, the only index these
  // tables have.
  const eventIds = events.map((event) => event.id);
  const ofCandidate = { candidateId, eventId: { in: eventIds } };
  const [rsvps, attendance] = eventIds.length > 0
    ? await Promise.all([
        client.eventRsvp.findMany({ where: ofCandidate, select: { eventId: true } }),
        client.eventAttendance.findMany({ where: ofCandidate, select: { eventId: true } })
      ])
    : [[], []];

  const rsvpedEventIds = new Set(rsvps.map((row) => row.eventId));
  const attendedEventIds = new Set(attendance.map((row) => row.eventId));

  const eventsWithStatus = events.map((event) => {
    const attended = attendedEventIds.has(event.id);
    return {
      ...event,
      rsvpStatus: rsvpedEventIds.has(event.id) ? 'RSVPed' : 'Not RSVPed',
      attendanceStatus: attended ? 'Attended' : 'Not Attended',
      points: attended ? 1 : 0
    };
  });

  // "Get to Know UC" meeting attendance shows as one more event.
  if (meetingAttendance) {
    eventsWithStatus.push({
      id: 'meeting-' + meetingAttendance.id,
      eventName: 'Get to Know UC',
      eventStartDate: meetingAttendance.slot.startTime,
      eventEndDate: meetingAttendance.slot.endTime,
      eventLocation: meetingAttendance.slot.location,
      rsvpStatus: 'RSVPed',
      attendanceStatus: 'Attended',
      points: 1,
      isMeeting: true,
      memberName: meetingAttendance.slot.member.fullName
    });
  }

  const totalPoints = eventsWithStatus.reduce((sum, event) => sum + event.points, 0);
  return { events: eventsWithStatus, totalPoints };
}

/**
 * Staging's participation points: one per distinct cycle event attended, one
 * more for Get to Know UC, capped at PARTICIPATION_MAX.
 */
export const participationPoints = (eventsAttended, attendedMeeting) =>
  Math.min(eventsAttended + (attendedMeeting ? 1 : 0), PARTICIPATION_MAX);

/**
 * participationPoints() for many candidates at once, keyed by candidateId: one
 * attendance query and one Get to Know UC query however many there are.
 * Counted exactly as Staging counts them: attendance at any of the cycle's
 * events, and a meeting matched on the application's own UID inside the cycle's
 * dates, never without a start date.
 *
 * `candidates` is [{ candidateId, studentId }], studentId from the application.
 */
export async function loadParticipationPoints({ client = prisma, cycleId, candidates }) {
  const points = new Map();
  if (!candidates.length) return points;

  const candidateIds = [...new Set(candidates.map((entry) => entry.candidateId).filter(Boolean))];
  const studentIds = [...new Set(candidates.map((entry) => entry.studentId).filter(Boolean))];
  const cycle = await client.recruitingCycle.findUnique({ where: { id: cycleId }, select: { startDate: true, endDate: true } });
  const start = cycle?.startDate ? new Date(cycle.startDate) : null;
  const end = cycle?.endDate ? new Date(cycle.endDate) : null;

  const [attendance, meetings] = await Promise.all([
    client.eventAttendance.findMany({
      where: { candidateId: { in: candidateIds }, event: { cycleId } },
      select: { candidateId: true, eventId: true }
    }),
    start && studentIds.length
      ? client.meetingSignup.findMany({
          where: {
            studentId: { in: studentIds },
            attended: true,
            slot: { startTime: { gte: start, ...(end && { lte: end }) } }
          },
          select: { studentId: true }
        })
      : []
  ]);

  const eventsOf = new Map();
  for (const row of attendance) {
    if (!eventsOf.has(row.candidateId)) eventsOf.set(row.candidateId, new Set());
    eventsOf.get(row.candidateId).add(row.eventId);
  }
  const met = new Set(meetings.map((row) => row.studentId));
  for (const { candidateId, studentId } of candidates) {
    points.set(candidateId, participationPoints(eventsOf.get(candidateId)?.size ?? 0, Boolean(studentId) && met.has(studentId)));
  }
  return points;
}

/**
 * Every referral on the candidate in the cycle, oldest first: manual ones added
 * on Application Detail and members' submissions alike. `referredBy` is the
 * submitting member, null on a manual referral.
 */
export async function getCycleReferrals({ client = prisma, candidateId, cycleId }) {
  return client.referral.findMany({
    where: { candidateId, cycleId },
    orderBy: { createdAt: 'asc' },
    include: { referredBy: { select: { id: true, fullName: true, email: true } } }
  });
}
