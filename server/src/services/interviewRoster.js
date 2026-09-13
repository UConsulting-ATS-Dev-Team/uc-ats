// Who is in an interview, and which group they count as.
//
// This is the seam that lets the roster move out of a JSON blob without
// rewriting the grading path.
//
// The roster used to live entirely in Interview.description: a stringified
// { memberGroups, applicationGroups, groupAssignments } with no foreign keys, no
// uniqueness and no cascade, written by the admin UI and parsed back out by
// every reader inside a try/catch. Slots replace it - a slot with its confirmed
// signups IS an application group, and the interviewers attached to that slot
// are its member group.
//
// The trick that makes the migration cheap: BehavioralQuestion.groupId is a bare
// String with no foreign key, and the ?groupIds= query contract is an opaque
// comma-separated list. Neither cares what a group id *is*. So a slot id is
// already a legal group id, and switching the source of truth is a matter of
// changing what resolves an id - not what produces one.
//
// Everything here answers in the blob's own shape, so the two admin routes and
// every live interview page keep working untouched. Interviews with no slots
// (final round, deliberations, past cycles) fall through to the blob exactly as
// before - slots replace groups only for interviews that have slots.

import prisma from '../prismaClient.js';

/** Parse the legacy config out of Interview.description, tolerating anything. */
export function parseLegacyConfig(interview) {
  const raw = interview?.description;
  if (!raw) return {};
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    // description doubles as a literal description on interviews that predate
    // the config, so a valid parse that is not an object is not a config.
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * The application ids behind a set of group ids.
 *
 * Accepts slot ids, the legacyGroupId a slot was backfilled from, and group ids
 * that only ever existed in the blob - in any mixture, because a bookmarked URL
 * or a half-migrated interview will contain exactly that. Slots win where both
 * exist, since they are the live record.
 */
export async function resolveGroupIds(interviewId, groupIds, client = prisma) {
  const ids = (Array.isArray(groupIds) ? groupIds : String(groupIds || '').split(','))
    .map((value) => String(value).trim())
    .filter(Boolean);
  if (ids.length === 0) return [];

  // "<slotId>:<label>" addresses one rotation group inside a session - the 1A
  // an interviewer is handed at their table. The plain form addresses the whole
  // session. Both are legal because this contract has always been opaque.
  const applicationIds = new Set();
  const matched = new Set();
  const rotationIds = ids.filter((id) => id.includes(':'));

  for (const id of rotationIds) {
    const [slotId, label] = id.split(':');
    const rows = await client.interviewSlotSignup.findMany({
      where: { slotId, groupLabel: label, status: 'CONFIRMED' },
      select: { applicationId: true },
    });
    if (rows.length > 0) {
      matched.add(id);
      for (const row of rows) applicationIds.add(row.applicationId);
    }
  }

  const slots = await client.interviewSlot.findMany({
    where: {
      interviewId,
      OR: [{ id: { in: ids } }, { legacyGroupId: { in: ids } }],
    },
    select: {
      id: true,
      legacyGroupId: true,
      signups: {
        where: { status: 'CONFIRMED' },
        select: { applicationId: true },
      },
    },
  });

  for (const slot of slots) {
    matched.add(slot.id);
    if (slot.legacyGroupId) matched.add(slot.legacyGroupId);
    for (const signup of slot.signups) applicationIds.add(signup.applicationId);
  }

  // Anything no slot claimed is still a blob group - an interview that was never
  // backfilled, or one whose groups predate slots entirely.
  const unmatched = ids.filter((id) => !matched.has(id));
  if (unmatched.length > 0) {
    const interview = await client.interview.findUnique({
      where: { id: interviewId },
      select: { description: true },
    });
    const config = parseLegacyConfig(interview);
    for (const group of config.applicationGroups ?? []) {
      if (!unmatched.includes(group.id)) continue;
      for (const applicationId of group.applicationIds ?? []) applicationIds.add(applicationId);
    }
  }

  return [...applicationIds];
}

/**
 * Every group id a set of ids should be read under, for behavioral questions.
 *
 * Questions written before a backfill are keyed on the old blob group id, and
 * ones written after are keyed on the slot id. Reading both keeps a group's
 * questions whole across the switch; writes use legacyGroupId ?? id (see
 * canonicalGroupIdFor) so they never start splitting across two keys mid-cycle.
 */
export async function expandGroupIdsForQuestions(interviewId, groupIds, client = prisma) {
  const ids = (Array.isArray(groupIds) ? groupIds : String(groupIds || '').split(','))
    .map((value) => String(value).trim())
    .filter(Boolean);
  if (ids.length === 0) return [];

  const slots = await client.interviewSlot.findMany({
    where: {
      interviewId,
      OR: [{ id: { in: ids } }, { legacyGroupId: { in: ids } }],
    },
    select: { id: true, legacyGroupId: true },
  });

  const expanded = new Set(ids);
  for (const slot of slots) {
    expanded.add(slot.id);
    if (slot.legacyGroupId) expanded.add(slot.legacyGroupId);
  }
  return [...expanded];
}

/**
 * The one id a new behavioral question should be written under.
 *
 * A backfilled slot keeps writing under its legacyGroupId so questions written
 * before and after the migration stay in one place. A slot created fresh has no
 * legacy id and uses its own.
 */
export async function canonicalGroupIdFor(interviewId, groupId, client = prisma) {
  const slot = await client.interviewSlot.findFirst({
    where: { interviewId, OR: [{ id: groupId }, { legacyGroupId: groupId }] },
    select: { id: true, legacyGroupId: true },
  });
  if (!slot) return groupId;
  return slot.legacyGroupId ?? slot.id;
}

/**
 * The interview's roster, in the shape the blob used to have.
 *
 * Computed from slots when the interview has any, parsed from description when
 * it does not. Returning the legacy shape is the whole point: the two admin
 * routes and the interview pages can be repointed here and the source of truth
 * flips server-side with no client change at all, which is what makes this safe
 * to ship before the admin UI is rewritten.
 */
export async function getRosterForInterview(interviewId, client = prisma) {
  const interview = await client.interview.findUnique({
    where: { id: interviewId },
    select: {
      id: true,
      description: true,
      slots: {
        orderBy: { startTime: 'asc' },
        select: {
          id: true,
          label: true,
          notes: true,
          legacyGroupId: true,
          startTime: true,
          endTime: true,
          candidateCapacity: true,
          signups: {
            where: { status: 'CONFIRMED' },
            select: { applicationId: true },
          },
          assignments: {
            where: { removedAt: null },
            select: { userId: true, role: true },
          },
        },
      },
    },
  });
  if (!interview) return null;

  if (interview.slots.length === 0) {
    const config = parseLegacyConfig(interview);
    return {
      source: 'legacy',
      memberGroups: config.memberGroups ?? [],
      applicationGroups: config.applicationGroups ?? [],
      groupAssignments: config.groupAssignments ?? {},
    };
  }

  const applicationGroups = [];
  const memberGroups = [];
  const groupAssignments = {};

  for (const slot of interview.slots) {
    // The group id a client will send back. legacyGroupId when there is one, so
    // URLs and question rows minted before the backfill keep resolving.
    const groupId = slot.legacyGroupId ?? slot.id;
    applicationGroups.push({
      id: groupId,
      name: slot.label || 'Session',
      notes: slot.notes ?? '',
      applicationIds: slot.signups.map((signup) => signup.applicationId),
      slotId: slot.id,
      startTime: slot.startTime,
      endTime: slot.endTime,
      capacity: slot.candidateCapacity,
    });

    if (slot.assignments.length > 0) {
      const memberGroupId = `members-${groupId}`;
      memberGroups.push({
        id: memberGroupId,
        name: slot.label || 'Session',
        memberIds: slot.assignments.map((assignment) => assignment.userId),
        slotId: slot.id,
      });
      // Co-membership in a slot is the assignment, so this mapping is now
      // derived rather than maintained by hand. The old groupAssignments map
      // existed only because groups had no time to agree on.
      groupAssignments[memberGroupId] = [groupId];
    }
  }

  return { source: 'slots', memberGroups, applicationGroups, groupAssignments };
}

/**
 * The interviews a member is actually on.
 *
 * Three ways somebody is attached, because the roster moved house mid-cycle and
 * all three still exist in live data:
 *
 *   InterviewSlotAssignment   the current one - a member on a session
 *   InterviewAssignment       the older table, still populated for past cycles
 *   memberGroups in the blob  how final round and past cycles were arranged
 *
 * Missing any of them would quietly hide an interview a member is genuinely
 * running, which is worse than showing one too many - so this is deliberately
 * generous, and the caller decides what to do with the answer.
 */
export async function interviewsAssignedTo(userId, interviews, client = prisma) {
  if (!interviews?.length) return [];
  const ids = interviews.map((interview) => interview.id);

  const [slotAssignments, legacyAssignments] = await Promise.all([
    client.interviewSlotAssignment.findMany({
      where: { userId, removedAt: null, interviewId: { in: ids } },
      select: { interviewId: true },
    }),
    client.interviewAssignment.findMany({
      where: { userId, interviewId: { in: ids } },
      select: { interviewId: true },
    }),
  ]);

  const assigned = new Set([
    ...slotAssignments.map((row) => row.interviewId),
    ...legacyAssignments.map((row) => row.interviewId),
  ]);

  for (const interview of interviews) {
    if (assigned.has(interview.id)) continue;
    const config = parseLegacyConfig(interview);
    const inAGroup = (config.memberGroups ?? []).some((group) =>
      (group.memberIds ?? []).includes(userId)
    );
    if (inAGroup) assigned.add(interview.id);
  }

  return interviews.filter((interview) => assigned.has(interview.id));
}
