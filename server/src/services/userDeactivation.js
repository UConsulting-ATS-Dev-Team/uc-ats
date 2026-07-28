import prisma from '../prismaClient.js';

export function parseGraduationYear(graduationClass) {
  if (typeof graduationClass !== 'string' || !graduationClass.trim()) return null;
  const match = graduationClass.match(/\b(19|20)\d{2}\b/);
  return match ? parseInt(match[0], 10) : null;
}

export function deactivationDateForYear(year) {
  return new Date(year, 11, 31, 23, 59, 59, 999);
}

// Relations we inspect for both counts and active-cycle references.
const USER_INCLUDE_FOR_DEACTIVATION_PREVIEW = {
  applications: { select: { cycleId: true } },
  comments: { select: { application: { select: { cycleId: true } } } },
  coverLetterScores: { select: { cycleId: true } },
  createdCases: { select: { cycleId: true } },
  createdInterviews: { select: { cycleId: true } },
  evaluations: { select: { id: true } },
  firstRoundEvaluations: { select: { interview: { select: { cycleId: true } } } },
  flaggedDocuments: { select: { application: { select: { cycleId: true } } } },
  groupMemberships: { select: { group: { select: { cycleId: true } } } },
  interviewAssignments: { select: { interview: { select: { cycleId: true } } } },
  interviewEvaluations: { select: { interview: { select: { cycleId: true } } } },
  interviewResources: { select: { id: true } },
  memberEventRsvp: { select: { event: { select: { cycleId: true } } } },
  memberOneGroups: { select: { cycleId: true } },
  memberTwoGroups: { select: { cycleId: true } },
  memberThreeGroups: { select: { cycleId: true } },
  meetingSlots: { select: { id: true } },
  resumeScores: { select: { cycleId: true } },
  resolvedDocuments: { select: { application: { select: { cycleId: true } } } },
  sentMessages: { select: { id: true } },
  videoScores: { select: { cycleId: true } },
  conversationParticipants: { select: { id: true } },
  completedActionItems: { select: { id: true } },
  createdBehavioralQuestions: { select: { id: true } },
  caseAssignments: { select: { case: { select: { cycleId: true } } } }
};

function inActiveCycle(cycleId, activeCycleIds) {
  return cycleId ? activeCycleIds.has(cycleId) : false;
}

export function userHasActiveCycleRelation(user, activeCycleIds) {
  if (user.applications?.some(a => inActiveCycle(a.cycleId, activeCycleIds))) return true;
  if (user.createdInterviews?.some(i => inActiveCycle(i.cycleId, activeCycleIds))) return true;
  if (user.memberOneGroups?.some(g => inActiveCycle(g.cycleId, activeCycleIds))) return true;
  if (user.memberTwoGroups?.some(g => inActiveCycle(g.cycleId, activeCycleIds))) return true;
  if (user.memberThreeGroups?.some(g => inActiveCycle(g.cycleId, activeCycleIds))) return true;
  if (user.groupMemberships?.some(gm => inActiveCycle(gm.group?.cycleId, activeCycleIds))) return true;
  if (user.memberEventRsvp?.some(r => inActiveCycle(r.event?.cycleId, activeCycleIds))) return true;
  if (user.interviewAssignments?.some(ia => inActiveCycle(ia.interview?.cycleId, activeCycleIds))) return true;
  if (user.interviewEvaluations?.some(ie => inActiveCycle(ie.interview?.cycleId, activeCycleIds))) return true;
  if (user.firstRoundEvaluations?.some(fre => inActiveCycle(fre.interview?.cycleId, activeCycleIds))) return true;
  if (user.resumeScores?.some(s => inActiveCycle(s.cycleId, activeCycleIds))) return true;
  if (user.coverLetterScores?.some(s => inActiveCycle(s.cycleId, activeCycleIds))) return true;
  if (user.videoScores?.some(s => inActiveCycle(s.cycleId, activeCycleIds))) return true;
  if (user.comments?.some(c => inActiveCycle(c.application?.cycleId, activeCycleIds))) return true;
  if (user.flaggedDocuments?.some(f => inActiveCycle(f.application?.cycleId, activeCycleIds))) return true;
  if (user.resolvedDocuments?.some(f => inActiveCycle(f.application?.cycleId, activeCycleIds))) return true;
  if (user.createdCases?.some(c => inActiveCycle(c.cycleId, activeCycleIds))) return true;
  if (user.caseAssignments?.some(ca => inActiveCycle(ca['case']?.cycleId, activeCycleIds))) return true;
  return false;
}

export function countRelations(user) {
  const counts = {
    applications: user.applications?.length || 0,
    scores: (user.resumeScores?.length || 0) + (user.coverLetterScores?.length || 0) + (user.videoScores?.length || 0),
    interviews: (user.interviewAssignments?.length || 0) + (user.interviewEvaluations?.length || 0) + (user.firstRoundEvaluations?.length || 0) + (user.createdInterviews?.length || 0),
    groups: (user.memberOneGroups?.length || 0) + (user.memberTwoGroups?.length || 0) + (user.memberThreeGroups?.length || 0) + (user.groupMemberships?.length || 0),
    events: user.memberEventRsvp?.length || 0,
    commentsMessages: (user.comments?.length || 0) + (user.sentMessages?.length || 0) + (user.conversationParticipants?.length || 0),
    cases: (user.createdCases?.length || 0) + (user.caseAssignments?.length || 0),
    resources: (user.interviewResources?.length || 0) + (user.createdBehavioralQuestions?.length || 0),
    other: (user.completedActionItems?.length || 0) + (user.meetingSlots?.length || 0) + (user.evaluations?.length || 0) + (user.flaggedDocuments?.length || 0) + (user.resolvedDocuments?.length || 0)
  };
  counts.total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return counts;
}

export async function getDeactivationCandidates({ graduationClass, requesterId, activeCycleIds }) {
  const normalizedClass = graduationClass.trim();
  if (normalizedClass.length > 100) {
    return { error: 'Invalid graduation class' };
  }

  const year = parseGraduationYear(normalizedClass);
  if (!year) {
    return { error: 'Could not determine a graduation year from the class value' };
  }

  const deactivationDate = deactivationDateForYear(year);
  const now = new Date();

  const users = await prisma.user.findMany({
    where: {
      role: 'MEMBER',
      isActive: true,
      graduationClass: normalizedClass
    },
    select: {
      id: true,
      fullName: true,
      email: true,
      graduationClass: true,
      role: true,
      isActive: true
    },
    orderBy: { fullName: 'asc' }
  });

  let usersWithRelations = [];
  if (users.length > 0) {
    usersWithRelations = await prisma.user.findMany({
      where: { id: { in: users.map(u => u.id) } },
      include: USER_INCLUDE_FOR_DEACTIVATION_PREVIEW
    });
  }

  const relMap = new Map(usersWithRelations.map(u => [u.id, u]));

  const eligible = [];
  const ineligible = [];
  const blocked = [];

  for (const user of users) {
    const relUser = relMap.get(user.id);
    if (!relUser) continue;

    if (user.id === requesterId) {
      ineligible.push({ ...user, reason: 'Cannot deactivate the current administrator' });
      continue;
    }

    if (now < deactivationDate) {
      ineligible.push({
        ...user,
        reason: `Deactivation date ${deactivationDate.toISOString().split('T')[0]} has not been reached`
      });
      continue;
    }

    if (userHasActiveCycleRelation(relUser, activeCycleIds)) {
      blocked.push({ ...user, reason: 'Has active/current-cycle relations' });
      continue;
    }

    eligible.push({ ...user, relations: countRelations(relUser) });
  }

  return {
    graduationClass: normalizedClass,
    year,
    deactivationDate: deactivationDate.toISOString(),
    eligibleCount: eligible.length,
    ineligibleCount: ineligible.length,
    blockedCount: blocked.length,
    totalFound: users.length,
    eligible,
    ineligible,
    blocked
  };
}
