// Admin service for copying candidate group membership into interview groups.
// The candidate group (Groups) is the source; the interview's applicationGroups
// JSON configuration is the destination. The copy is previewed before commit and
// is audited in Interview.description so the action can be reviewed later.

import { randomUUID } from 'crypto';

// Required fields on a candidate's application that must be present before the
// candidate can be placed into an interview group. These match the non-nullable
// Application columns plus the documents needed for interviews.
export const REQUIRED_APPLICATION_FIELDS = [
  { key: 'email', label: 'Email' },
  { key: 'firstName', label: 'First Name' },
  { key: 'lastName', label: 'Last Name' },
  { key: 'studentId', label: 'Student ID' },
  { key: 'phoneNumber', label: 'Phone Number' },
  { key: 'graduationYear', label: 'Graduation Year' },
  { key: 'cumulativeGpa', label: 'Cumulative GPA' },
  { key: 'major1', label: 'Major' },
  { key: 'resumeUrl', label: 'Resume' },
  { key: 'headshotUrl', label: 'Headshot' },
];

function parseInterviewDescription(interview) {
  if (!interview?.description) return {};
  try {
    return typeof interview.description === 'string'
      ? JSON.parse(interview.description)
      : interview.description;
  } catch {
    console.warn('Failed to parse interview description for copy:', interview.id);
    return {};
  }
}

function isEmptyValue(value) {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') return value.trim() === '';
  if (typeof value === 'number') return Number.isNaN(value);
  return false;
}

function validateApplication(application) {
  const missingFields = [];
  for (const { key, label } of REQUIRED_APPLICATION_FIELDS) {
    const value = application[key];
    if (key === 'cumulativeGpa') {
      if (isEmptyValue(value) || Number.isNaN(Number(String(value)))) {
        missingFields.push(label);
      }
    } else if (isEmptyValue(value)) {
      missingFields.push(label);
    }
  }
  return missingFields;
}

function buildCandidatePreview(candidate, application, reason, missingFields = []) {
  const firstName = candidate.firstName || application?.firstName || '';
  const lastName = candidate.lastName || application?.lastName || '';
  return {
    candidateId: candidate.id,
    studentId: candidate.studentId || application?.studentId || null,
    firstName,
    lastName,
    applicationId: application?.id || null,
    reason,
    missingFields: missingFields.length > 0 ? missingFields : undefined,
  };
}

async function loadAndComputeCopy(tx, { interviewId, sourceGroupId, targetGroupId, mode, actorId, persist }) {
  const interview = await tx.interview.findUnique({
    where: { id: interviewId },
    select: { id: true, title: true, cycleId: true, description: true },
  });

  if (!interview) {
    throw new Error('Interview not found');
  }

  const sourceGroup = await tx.groups.findUnique({
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

  if (!sourceGroup) {
    throw new Error('Source candidate group not found');
  }

  if (sourceGroup.cycleId !== interview.cycleId) {
    throw new Error('Source group and interview must belong to the same recruiting cycle');
  }

  const config = parseInterviewDescription(interview);
  const applicationGroups = config.applicationGroups || [];

  let targetGroup = null;
  let createdNewGroup = false;
  if (targetGroupId) {
    targetGroup = applicationGroups.find((g) => g.id === targetGroupId);
    if (!targetGroup) {
      throw new Error('Target interview group not found');
    }
  }

  if (!targetGroup) {
    targetGroup = {
      id: randomUUID(),
      name: sourceGroup.name ? `${sourceGroup.name} (Interview)` : 'Copied Group',
      applicationIds: [],
      notes: '',
    };
    createdNewGroup = true;
  }

  const existingApplicationIds = targetGroup.applicationIds || [];
  const existingIdSet = new Set(existingApplicationIds);

  const additions = [];
  const duplicates = [];
  const skipped = [];

  for (const candidate of sourceGroup.assignedCandidates) {
    const application = candidate.applications?.find(
      (a) => a.cycleId === interview.cycleId
    );

    if (!application) {
      skipped.push(buildCandidatePreview(candidate, null, 'no_application'));
      continue;
    }

    const missingFields = validateApplication(application);
    if (missingFields.length > 0) {
      skipped.push(buildCandidatePreview(candidate, application, 'missing_required_data', missingFields));
      continue;
    }

    const preview = buildCandidatePreview(candidate, application, null);
    if (existingIdSet.has(application.id)) {
      duplicates.push(preview);
    } else {
      additions.push(preview);
    }
  }

  const eligibleIds = new Set([
    ...additions.map((a) => a.applicationId),
    ...duplicates.map((d) => d.applicationId),
  ]);
  const removals = mode === 'replace'
    ? existingApplicationIds.filter((id) => !eligibleIds.has(id)).map((applicationId) => ({ applicationId }))
    : [];

  let finalApplicationIds;
  if (mode === 'replace') {
    const existingIdsInSource = existingApplicationIds.filter((id) => eligibleIds.has(id));
    const newIds = additions.map((a) => a.applicationId);
    finalApplicationIds = Array.from(new Set([...existingIdsInSource, ...newIds]));
  } else {
    const combined = [...existingApplicationIds, ...additions.map((a) => a.applicationId)];
    finalApplicationIds = Array.from(new Set(combined));
  }

  targetGroup.applicationIds = finalApplicationIds;

  const audit = {
    id: randomUUID(),
    sourceGroupId: sourceGroup.id,
    sourceGroupName: sourceGroup.name || 'Untitled Group',
    targetGroupId: targetGroup.id,
    targetGroupName: targetGroup.name,
    mode,
    copiedBy: actorId || null,
    copiedAt: new Date().toISOString(),
    additions: additions.map((a) => ({ candidateId: a.candidateId, applicationId: a.applicationId })),
    duplicates: duplicates.map((d) => ({ candidateId: d.candidateId, applicationId: d.applicationId })),
    skipped: skipped.map((s) => ({
      candidateId: s.candidateId,
      applicationId: s.applicationId,
      reason: s.reason,
      missingFields: s.missingFields,
    })),
    removals: removals.map((r) => ({ applicationId: r.applicationId })),
    additionsCount: additions.length,
    duplicatesCount: duplicates.length,
    skippedCount: skipped.length,
    removalsCount: removals.length,
  };

  let updatedConfig;
  if (persist) {
    let updatedApplicationGroups = applicationGroups;
    if (createdNewGroup) {
      updatedApplicationGroups = [...applicationGroups, targetGroup];
    } else {
      updatedApplicationGroups = applicationGroups.map((g) =>
        g.id === targetGroup.id ? targetGroup : g
      );
    }

    updatedConfig = {
      ...config,
      applicationGroups: updatedApplicationGroups,
      copyAudits: [...(config.copyAudits || []), audit],
    };

    await tx.interview.update({
      where: { id: interviewId },
      data: { description: JSON.stringify(updatedConfig) },
    });
  } else {
    updatedConfig = {
      ...config,
      applicationGroups: applicationGroups.map((g) => (g.id === targetGroup.id ? targetGroup : g)),
    };
  }

  return {
    config: updatedConfig,
    audit,
    additions,
    duplicates,
    skipped,
    removals,
    existingApplicationCount: existingApplicationIds.length,
    targetGroup,
    createdNewGroup,
  };
}

async function buildCopyResult(args) {
  const { prisma, interviewId, sourceGroupId, targetGroupId, mode, actorId, persist } = args;

  if (!interviewId || !sourceGroupId) {
    throw new Error('Interview and source group are required');
  }

  if (!['add', 'replace'].includes(mode)) {
    throw new Error("Mode must be 'add' or 'replace'");
  }

  let copyResult;

  if (persist) {
    await prisma.$transaction(async (tx) => {
      // Serialize group copy commits for this interview to prevent concurrent
      // read-modify-write races on the JSON description field.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('interview_group_copy_' || ${interviewId})::bigint)`;
      copyResult = await loadAndComputeCopy(tx, { interviewId, sourceGroupId, targetGroupId, mode, actorId, persist });
    });
  } else {
    copyResult = await loadAndComputeCopy(prisma, { interviewId, sourceGroupId, targetGroupId, mode, actorId, persist });
  }

  const { config, audit, additions, duplicates, skipped, removals, existingApplicationCount, targetGroup } = copyResult;

  const preview = {
    interviewId,
    sourceGroup: { id: audit.sourceGroupId, name: audit.sourceGroupName },
    targetGroup: {
      id: targetGroup.id,
      name: targetGroup.name,
      preCopyApplicationCount: existingApplicationCount,
      postCopyApplicationCount: targetGroup.applicationIds.length,
    },
    mode,
    additions,
    duplicates,
    skipped,
    removals,
    counts: {
      additions: audit.additionsCount,
      duplicates: audit.duplicatesCount,
      skipped: audit.skippedCount,
      removals: audit.removalsCount,
    },
  };

  return { preview, config, audit };
}

export async function previewCopyCandidateGroupToInterview({ prisma, interviewId, sourceGroupId, targetGroupId, mode = 'add' }) {
  const { preview } = await buildCopyResult({
    prisma,
    interviewId,
    sourceGroupId,
    targetGroupId,
    mode,
    persist: false,
  });
  return preview;
}

export async function commitCopyCandidateGroupToInterview({
  prisma,
  interviewId,
  sourceGroupId,
  targetGroupId,
  mode = 'add',
  actorId,
}) {
  return buildCopyResult({
    prisma,
    interviewId,
    sourceGroupId,
    targetGroupId,
    mode,
    actorId,
    persist: true,
  });
}
