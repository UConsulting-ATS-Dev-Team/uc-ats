// Admin service to copy candidate group membership into an interview group/session.
//
// Source: a review-team / candidate group (Groups) with assignedCandidates.
// Destination: an Interview's applicationGroups config stored in the description JSON.
//
// The copy is add-only and idempotent by default. It never mutates the source
// candidate group, never assigns interviewers, and never sends invitations.

import { randomUUID } from 'crypto';

const COPY_LOCK_PREFIX = 'candidate_group_copy_';

function parseInterviewDescription(interview) {
  if (!interview || !interview.description) {
    return { memberGroups: [], applicationGroups: [], groupAssignments: {} };
  }

  if (typeof interview.description === 'object') {
    return interview.description;
  }

  try {
    const parsed = JSON.parse(interview.description);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function configToDescription(config) {
  return JSON.stringify(config);
}

function isValidApplication(application) {
  if (!application) return false;
  return (
    application.id &&
    application.firstName?.trim() &&
    application.lastName?.trim() &&
    application.email?.trim()
  );
}

function candidateDisplayName(candidate, application) {
  const first = application?.firstName?.trim() || candidate.firstName?.trim() || '';
  const last = application?.lastName?.trim() || candidate.lastName?.trim() || '';
  const name = `${first} ${last}`.trim();
  return name || candidate.email || candidate.studentId || candidate.id;
}

async function loadInterviewAndGroup(prisma, destinationInterviewId, sourceGroupId, options = {}) {
  const { useTransaction = false } = options;
  const client = useTransaction ? prisma : prisma;

  const interview = await client.interview.findUnique({
    where: { id: destinationInterviewId },
    include: { cycle: true },
  });

  if (!interview) {
    throw Object.assign(new Error('Interview not found'), { name: 'NotFoundError' });
  }

  const group = await client.groups.findUnique({
    where: { id: sourceGroupId },
    include: {
      assignedCandidates: {
        include: {
          applications: {
            where: { cycleId: interview.cycleId },
            orderBy: { submittedAt: 'desc' },
            take: 1,
          },
        },
      },
    },
  });

  if (!group) {
    throw Object.assign(new Error('Source candidate group not found'), { name: 'NotFoundError' });
  }

  if (group.cycleId !== interview.cycleId) {
    throw Object.assign(
      new Error('Source candidate group and destination interview must belong to the same recruiting cycle'),
      { name: 'CycleMismatchError' }
    );
  }

  return { interview, group };
}

function classifyCandidates(group, targetGroup, actorId, now) {
  const additions = [];
  const duplicates = [];
  const skipped = [];

  const existingApplicationIds = new Set(targetGroup?.applicationIds || []);

  for (const candidate of group.assignedCandidates || []) {
    const application = candidate.applications?.[0];

    if (!isValidApplication(application)) {
      skipped.push({
        candidateId: candidate.id,
        studentId: candidate.studentId || null,
        name: candidateDisplayName(candidate, application),
        reason: application ? 'missing_required_data' : 'no_application_in_cycle',
      });
      continue;
    }

    const entry = {
      candidateId: candidate.id,
      applicationId: application.id,
      studentId: application.studentId || candidate.studentId || null,
      name: `${application.firstName.trim()} ${application.lastName.trim()}`,
      email: application.email,
    };

    if (existingApplicationIds.has(application.id)) {
      duplicates.push(entry);
    } else {
      additions.push(entry);
    }
  }

  return { additions, duplicates, skipped };
}

function buildTargetGroup(sourceGroup, destinationGroupId, additions, actorId, now) {
  const baseApplicationIds = destinationGroupId ? (destinationGroupId.applicationIds || []) : [];
  // preserve order of existing IDs, then append new additions
  const mergedApplicationIds = [
    ...baseApplicationIds,
    ...additions.map((a) => a.applicationId).filter((id) => !baseApplicationIds.includes(id)),
  ];

  return {
    id: destinationGroupId?.id || randomUUID(),
    name: destinationGroupId?.name || sourceGroup.name || `Copy of ${sourceGroup.id.slice(-8)}`,
    applicationIds: mergedApplicationIds,
    notes: destinationGroupId?.notes || '',
    copiedFromGroupId: sourceGroup.id,
    copiedByUserId: actorId,
    copiedAt: now.toISOString(),
  };
}

export async function previewCandidateGroupCopy({
  prisma,
  sourceGroupId,
  destinationInterviewId,
  destinationGroupId,
}) {
  if (!sourceGroupId || !destinationInterviewId) {
    throw new Error('sourceGroupId and destinationInterviewId are required');
  }

  const { interview, group } = await loadInterviewAndGroup(
    prisma,
    destinationInterviewId,
    sourceGroupId
  );

  const config = parseInterviewDescription(interview);
  const applicationGroups = Array.isArray(config.applicationGroups) ? config.applicationGroups : [];
  const targetGroup = destinationGroupId
    ? applicationGroups.find((g) => g.id === destinationGroupId)
    : null;

  const { additions, duplicates, skipped } = classifyCandidates(group, targetGroup);

  return {
    sourceGroup: {
      id: group.id,
      name: group.name || `Team ${group.id.slice(-4)}`,
      candidateCount: group.assignedCandidates?.length || 0,
    },
    destinationInterview: {
      id: interview.id,
      title: interview.title,
      cycleId: interview.cycleId,
    },
    destinationGroup: targetGroup
      ? {
          id: targetGroup.id,
          name: targetGroup.name,
          existingApplicationCount: targetGroup.applicationIds?.length || 0,
        }
      : {
          id: null,
          name: group.name || `Copy of ${group.id.slice(-4)}`,
          existingApplicationCount: 0,
          isNew: true,
        },
    additions,
    duplicates,
    skipped,
    additionCount: additions.length,
    duplicateCount: duplicates.length,
    skippedCount: skipped.length,
  };
}

export async function commitCandidateGroupCopy({
  prisma,
  sourceGroupId,
  destinationInterviewId,
  destinationGroupId,
  actorId,
  mode = 'add',
}) {
  if (!sourceGroupId || !destinationInterviewId) {
    throw new Error('sourceGroupId and destinationInterviewId are required');
  }

  if (mode !== 'add') {
    throw new Error('Only add-only mode is supported');
  }

  const now = new Date();

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${COPY_LOCK_PREFIX + destinationInterviewId}))`;

    const { interview, group } = await loadInterviewAndGroup(
      tx,
      destinationInterviewId,
      sourceGroupId,
      { useTransaction: true }
    );

    const config = parseInterviewDescription(interview);
    const applicationGroups = Array.isArray(config.applicationGroups) ? config.applicationGroups : [];

    const existingGroupIndex = destinationGroupId
      ? applicationGroups.findIndex((g) => g.id === destinationGroupId)
      : -1;

    const existingGroup = existingGroupIndex >= 0 ? applicationGroups[existingGroupIndex] : null;

    const { additions, duplicates, skipped } = classifyCandidates(group, existingGroup, actorId, now);

    const updatedGroup = buildTargetGroup(group, existingGroup, additions, actorId, now);

    if (existingGroupIndex >= 0) {
      applicationGroups[existingGroupIndex] = updatedGroup;
    } else {
      applicationGroups.push(updatedGroup);
    }

    config.applicationGroups = applicationGroups;

    const updatedInterview = await tx.interview.update({
      where: { id: interview.id },
      data: {
        description: configToDescription(config),
      },
      include: { cycle: true },
    });

    return {
      interview: {
        id: updatedInterview.id,
        title: updatedInterview.title,
        cycleId: updatedInterview.cycleId,
      },
      destinationGroup: {
        id: updatedGroup.id,
        name: updatedGroup.name,
        applicationIds: updatedGroup.applicationIds,
        previousCount: existingGroup?.applicationIds?.length || 0,
        newCount: updatedGroup.applicationIds.length,
      },
      sourceGroup: {
        id: group.id,
        name: group.name || `Team ${group.id.slice(-4)}`,
      },
      additions,
      duplicates,
      skipped,
      additionCount: additions.length,
      duplicateCount: duplicates.length,
      skippedCount: skipped.length,
      copiedByUserId: actorId,
      copiedAt: now.toISOString(),
    };
  });
}
