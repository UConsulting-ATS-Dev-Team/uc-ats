// Who is asked for availability on a round staffed by a chosen few.
//
// First round asks the whole roster: it needs as many panels as it can get, and
// how many it gets is decided by who says they are free. Final round does not.
// Recruitment picks the members it wants in those rooms, so asking all sixty
// collects answers from people who will never be placed, and fills the coverage
// grid with panels that cannot run.
//
// On an invite-only round, then, the AvailabilityInvite rows are the roster:
// only those members see the form, only their answers are counted, and only
// they are emailed. Placement is not gated. An admin can still put anybody on a
// session by hand, as on every other round.
//
// The routes decide when somebody is asked. This decides who may answer and
// whose answers count.

import prisma from '../prismaClient.js';

/** Rounds whose availability is asked of picked members, not everyone. */
export const INVITE_ONLY_TYPES = new Set(['FINAL_ROUND']);

export const isInviteOnly = (interviewType) => INVITE_ONLY_TYPES.has(interviewType);

const STAFF_ROLES = ['MEMBER', 'ADMIN'];

/** The ids invited to give availability for one interview. */
export async function invitedUserIds(interviewId, db = prisma) {
  const rows = await db.availabilityInvite.findMany({
    where: { interviewId },
    select: { userId: true },
  });
  return new Set(rows.map((row) => row.userId));
}

/**
 * Whether this member may see and answer the interview's availability form.
 * Every staff member may on an open round; on an invite-only one, only the
 * people invited.
 */
export async function canAnswerAvailability(interview, userId, db = prisma) {
  if (!isInviteOnly(interview.interviewType)) return true;
  const invite = await db.availabilityInvite.findUnique({
    where: { interviewId_userId: { interviewId: interview.id, userId } },
    select: { id: true },
  });
  return Boolean(invite);
}

/** The interviews in `interviews` this member may answer, in the same order. */
export async function filterAnswerable(interviews, userId, db = prisma) {
  const gated = interviews.filter((i) => isInviteOnly(i.interviewType)).map((i) => i.id);
  if (gated.length === 0) return interviews;
  const invited = new Set(
    (
      await db.availabilityInvite.findMany({
        where: { userId, interviewId: { in: gated } },
        select: { interviewId: true },
      })
    ).map((row) => row.interviewId)
  );
  return interviews.filter((i) => !isInviteOnly(i.interviewType) || invited.has(i.id));
}

/**
 * The availability rows that count towards an interview's grid. On an
 * invite-only round, an answer from someone since uninvited is kept in the
 * table (so inviting them again restores it) but not counted.
 */
export const countedWindows = (interviewType, windows, invited) =>
  isInviteOnly(interviewType) ? windows.filter((w) => invited.has(w.userId)) : windows;

/**
 * Invite these members. Only active members and admins can be invited; any
 * other id is refused, so a stale picker cannot invite a deactivated account.
 * Inviting somebody already invited changes nothing.
 */
export async function inviteToAvailability(interviewId, userIds, invitedById, db = prisma) {
  const ids = [...new Set(userIds)];
  const staff = await db.user.findMany({
    where: { id: { in: ids }, isActive: true, role: { in: STAFF_ROLES } },
    select: { id: true },
  });
  if (staff.length !== ids.length) {
    const found = new Set(staff.map((u) => u.id));
    const err = new Error(
      `${ids.length - found.size} of the people picked are not active members, so nobody was invited`
    );
    err.status = 400;
    throw err;
  }
  await db.availabilityInvite.createMany({
    data: ids.map((userId) => ({ interviewId, userId, invitedById })),
    skipDuplicates: true,
  });
  return ids;
}

/** Stop asking this member. What they already said is kept, but not counted. */
export async function removeAvailabilityInvite(interviewId, userId, db = prisma) {
  const { count } = await db.availabilityInvite.deleteMany({ where: { interviewId, userId } });
  return count > 0;
}

/**
 * Who a "ask for availability" press emails.
 *
 * - Open round: the whole roster, or only those who have not answered.
 * - Invite-only round, with `picked`: exactly the people just picked, answered
 *   or not. An admin who picks somebody by name means to ask them.
 * - Invite-only round, without: the invited, or only those who have not
 *   answered - the "chase" press.
 */
export function availabilityRecipients({ interviewType, staff, invited, answered, picked, everyone }) {
  const withEmail = staff.filter((user) => user.email);
  if (!isInviteOnly(interviewType)) {
    return withEmail.filter((user) => everyone || !answered.has(user.id));
  }
  if (picked) {
    const chosen = new Set(picked);
    return withEmail.filter((user) => chosen.has(user.id));
  }
  return withEmail.filter((user) => invited.has(user.id) && (everyone || !answered.has(user.id)));
}
