// What the Document Grading pages list: each application, who has graded each
// of its documents, and any open flag. Shared by a member's own queue
// (/api/review-teams/member-applications) and the admin's whole-cycle view
// (/api/admin/applications, via loadAdminApplications).
//
// Every read here is a round trip to the database, and those dominate how long
// the page takes to load, so reads that do not depend on each other run together.

import { getGroupMemberUsers } from '../utils/groupMembers.js';

const MEMBER_USER_SELECT = { id: true, fullName: true, email: true, profileImage: true };

export const GROUP_WITH_MEMBERS_SELECT = {
  id: true,
  name: true,
  memberOne: true,
  memberTwo: true,
  memberThree: true,
  memberOneUser: { select: MEMBER_USER_SELECT },
  memberTwoUser: { select: MEMBER_USER_SELECT },
  memberThreeUser: { select: MEMBER_USER_SELECT },
  groupMembers: { select: { userId: true, user: { select: MEMBER_USER_SELECT } } }
};

// Only the columns a grading row shows. A whole application row also carries
// rawResponses, the entire form submission, which is most of its size and none
// of this page.
export const GRADING_APPLICATION_SELECT = {
  id: true,
  candidateId: true,
  firstName: true,
  lastName: true,
  major1: true,
  graduationYear: true,
  cumulativeGpa: true,
  status: true,
  approved: true,
  currentRound: true,
  email: true,
  submittedAt: true,
  headshotUrl: true,
  gender: true,
  isFirstGeneration: true,
  isTransferStudent: true,
  resumeUrl: true,
  coverLetterUrl: true,
  shortAnswer: true,
  videoUrl: true
};

const SCORE_SELECT = { candidateId: true, evaluatorId: true, assignedGroupId: true };

/**
 * Every grader's resume, cover letter and video score in the cycle for these
 * candidates, plus the open flags on these applications, read in parallel.
 */
export async function loadGradingRecords(client, { cycleId, candidateIds, applicationIds }) {
  const scoreWhere = { cycleId, candidateId: { in: candidateIds } };
  const [resume, coverLetter, video, flags] = await Promise.all([
    client.resumeScore.findMany({ where: scoreWhere, select: SCORE_SELECT }),
    client.coverLetterScore.findMany({ where: scoreWhere, select: SCORE_SELECT }),
    client.videoScore.findMany({ where: scoreWhere, select: SCORE_SELECT }),
    client.flaggedDocument.findMany({
      where: { applicationId: { in: applicationIds }, isResolved: false },
      select: {
        applicationId: true,
        documentType: true,
        reason: true,
        message: true,
        flaggedBy: true,
        createdAt: true
      }
    })
  ]);
  return { scores: { resume, coverLetter, video }, flags };
}

const NO_TEAM = { completed: false, missingGrades: 0, totalMembers: 0, teamMembers: [], completedEvaluators: [] };

/** Which of the candidate's team have scored this document, and how many have not. */
export function teamCompletion(candidateId, group, scores) {
  if (!group) return NO_TEAM;
  const teamMembers = getGroupMemberUsers(group);
  if (teamMembers.length === 0) return NO_TEAM;

  const completedEvaluators = scores
    .filter(score => score.candidateId === candidateId && score.assignedGroupId === group.id)
    .map(score => score.evaluatorId);

  return {
    completed: teamMembers.every(member => completedEvaluators.includes(member.id)),
    missingGrades: teamMembers.length - completedEvaluators.length,
    totalMembers: teamMembers.length,
    teamMembers,
    completedEvaluators
  };
}

export function findFlag(flags, applicationId, documentType) {
  return flags.find(flag => flag.applicationId === applicationId && flag.documentType === documentType);
}

/**
 * The applications on the review teams `memberId` sits on, marked with what
 * `evaluatorId` has graded. An admin reading someone else's queue passes their
 * own id as the evaluator, as the route always has.
 */
export async function loadMemberGradingQueue(client, { cycle, memberId, evaluatorId }) {
  const onTeam = {
    cycleId: cycle.id,
    OR: [
      { memberOne: memberId },
      { memberTwo: memberId },
      { memberThree: memberId },
      { groupMembers: { some: { userId: memberId } } }
    ]
  };

  // The candidates are found through the same team filter rather than through
  // the groups' ids, so neither read waits for the other.
  const [memberGroups, candidates] = await Promise.all([
    client.groups.findMany({ where: onTeam, select: GROUP_WITH_MEMBERS_SELECT }),
    client.candidate.findMany({
      where: { assignedGroup: { is: onTeam } },
      select: {
        id: true,
        studentId: true,
        assignedGroupId: true,
        applications: {
          where: { cycleId: cycle.id },
          orderBy: { submittedAt: 'desc' },
          take: 1,
          select: GRADING_APPLICATION_SELECT
        }
      }
    })
  ]);

  const rows = candidates.filter(candidate => candidate.applications[0]);
  if (memberGroups.length === 0 || rows.length === 0) return [];

  const { scores, flags } = await loadGradingRecords(client, {
    cycleId: cycle.id,
    candidateIds: rows.map(candidate => candidate.id),
    applicationIds: rows.map(candidate => candidate.applications[0].id)
  });

  const gradedBy = (list, candidateId) =>
    list.some(score => score.candidateId === candidateId && score.evaluatorId === evaluatorId);

  return rows.map(candidate => {
    const application = candidate.applications[0];
    const group = memberGroups.find(g => g.id === candidate.assignedGroupId);
    const resumeStatus = teamCompletion(candidate.id, group, scores.resume);
    const coverLetterStatus = teamCompletion(candidate.id, group, scores.coverLetter);
    const videoStatus = teamCompletion(candidate.id, group, scores.video);

    return {
      id: application.id,
      candidateId: candidate.id,
      cycleId: cycle.id,
      studentId: candidate.studentId,
      name: `${application.firstName} ${application.lastName}`,
      major: application.major1 || 'N/A',
      year: application.graduationYear || 'N/A',
      gpa: application.cumulativeGpa?.toString() || 'N/A',
      status: application.status || 'SUBMITTED',
      email: application.email,
      submittedAt: application.submittedAt,
      headshotUrl: application.headshotUrl,
      gender: application.gender || 'N/A',
      isFirstGeneration: application.isFirstGeneration,
      isTransferStudent: application.isTransferStudent,
      resumeUrl: application.resumeUrl,
      coverLetterUrl: application.coverLetterUrl,
      shortAnswer: application.shortAnswer,
      videoUrl: application.videoUrl,
      groupId: group?.id,
      groupName: group ? `Team ${group.id.slice(-4)}` : 'Unknown Team',
      // The evaluator's own grades, not the team's
      hasResumeScore: gradedBy(scores.resume, candidate.id),
      hasCoverLetterScore: gradedBy(scores.coverLetter, candidate.id),
      hasVideoScore: gradedBy(scores.video, candidate.id),
      resumeMissingGrades: resumeStatus.missingGrades,
      coverLetterMissingGrades: coverLetterStatus.missingGrades,
      videoMissingGrades: videoStatus.missingGrades,
      resumeTotalMembers: resumeStatus.totalMembers,
      coverLetterTotalMembers: coverLetterStatus.totalMembers,
      videoTotalMembers: videoStatus.totalMembers,
      groupMembers: resumeStatus.teamMembers,
      resumeCompletedEvaluators: resumeStatus.completedEvaluators,
      coverLetterCompletedEvaluators: coverLetterStatus.completedEvaluators,
      videoCompletedEvaluators: videoStatus.completedEvaluators,
      resumeFlagged: findFlag(flags, application.id, 'resume') || null,
      coverLetterFlagged: findFlag(flags, application.id, 'coverLetter') || null,
      videoFlagged: findFlag(flags, application.id, 'video') || null
    };
  });
}
