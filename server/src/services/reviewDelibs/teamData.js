import prisma from '../../prismaClient.js';
import { loadParticipationPoints } from '../applicationParticipation.js';
import { DOCUMENT_TYPES, getRubrics } from '../documentRubrics.js';
import { getGroupMemberUsers, groupMemberUserInclude } from '../../utils/groupMembers.js';
import { sealedRowPredicate } from '../../utils/lockedRecords.js';
import { hasCoverLetter } from '../../utils/coverLetter.js';
import { isOwnedBy } from '../../utils/applicationOwnership.js';
import { normalizeRow } from './teamStats.js';

// Reads what teamStats.js computes over: every review team in the cycle, their
// candidates' current applications, and every document score in the cycle. The
// whole cycle, not one team, because the overview compares the team with the
// others.
//
// Sealed candidates stay in the candidate list as identity (so the team's count
// matches what everyone knows it graded) and their scores are dropped here,
// before any arithmetic. The executive unlock is deliberately not consulted: the
// session is one screen shown to the whole team.

const SCORE_MODEL = { resume: 'resumeScore', coverLetter: 'coverLetterScore', video: 'videoScore' };

const SCORE_SELECT = {
  id: true,
  candidateId: true,
  evaluatorId: true,
  overallScore: true,
  adminScore: true,
  adminNotes: true,
  scoreOne: true,
  scoreTwo: true,
  scoreThree: true,
  evaluator: { select: { fullName: true } }
};
const NOTE_SELECT = { resume: { notes: true }, coverLetter: { notesOne: true }, video: { notesOne: true } };

export const APPLICATION_SELECT = {
  id: true,
  candidateId: true,
  cycleId: true,
  firstName: true,
  lastName: true,
  email: true,
  studentId: true,
  major1: true,
  major2: true,
  graduationYear: true,
  cumulativeGpa: true,
  headshotUrl: true,
  resumeUrl: true,
  coverLetterUrl: true,
  shortAnswer: true,
  videoUrl: true,
  resumeDecision: true,
  submittedAt: true
};

export const scoreModel = (type) => SCORE_MODEL[type] || null;

/**
 * The input computeTeamStats() takes, for `groupId`'s cycle. `participation:
 * false` skips the participation points and the rank population, for callers
 * that only need the outlier walkthrough.
 */
export async function loadTeamInput({ client = prisma, groupId, cycleId, participation = true }) {
  const [groups, rubrics, ...scoreSets] = await Promise.all([
    client.groups.findMany({
      where: { cycleId },
      include: {
        ...groupMemberUserInclude,
        assignedCandidates: {
          select: {
            id: true,
            email: true,
            studentId: true,
            applications: {
              where: { cycleId },
              orderBy: { submittedAt: 'desc' },
              take: 1,
              select: APPLICATION_SELECT
            }
          }
        }
      },
      orderBy: { createdAt: 'asc' }
    }),
    getRubrics({ client }),
    ...DOCUMENT_TYPES.map((type) => client[SCORE_MODEL[type]].findMany({
      where: { cycleId },
      select: { ...SCORE_SELECT, ...NOTE_SELECT[type] }
    }))
  ]);

  // Staff never grade their own application, so a member is not owed a grade
  // on it. Matched the way the grading routes refuse it (isOwnedBy), which needs
  // each member's student ID as well as their address.
  const memberIds = [...new Set(groups.flatMap((group) => getGroupMemberUsers(group).map((user) => user.id)))];
  const staff = memberIds.length
    ? await client.user.findMany({ where: { id: { in: memberIds } }, select: { id: true, email: true, studentId: true } })
    : [];

  const candidates = [];
  for (const group of groups) {
    const members = staff.filter((user) => getGroupMemberUsers(group).some((member) => member.id === user.id));
    for (const candidate of group.assignedCandidates) {
      const application = candidate.applications[0];
      if (!application) continue;
      const owned = { ...application, candidate: { email: candidate.email, studentId: candidate.studentId } };
      candidates.push({
        excludedGraderIds: members.filter((user) => isOwnedBy(owned, user)).map((user) => user.id),
        candidateId: candidate.id,
        applicationId: application.id,
        groupId: group.id,
        name: `${application.firstName} ${application.lastName}`.trim(),
        major: application.major1 || null,
        year: application.graduationYear || null,
        hasDoc: {
          resume: Boolean(application.resumeUrl),
          coverLetter: hasCoverLetter(application),
          video: Boolean(application.videoUrl)
        },
        resumeDecision: application.resumeDecision ?? null,
        application
      });
    }
  }

  const isSealed = await sealedRowPredicate(candidates, { client });
  const sealedIds = new Set(candidates.filter(isSealed).map((candidate) => candidate.candidateId));
  for (const candidate of candidates) candidate.locked = sealedIds.has(candidate.candidateId);

  const known = new Set(candidates.map((candidate) => candidate.candidateId));
  const rows = DOCUMENT_TYPES.flatMap((type, index) =>
    scoreSets[index]
      .filter((row) => known.has(row.candidateId) && !sealedIds.has(row.candidateId))
      .map((row) => normalizeRow(row, type)));

  // Staging's participation points, so the overall here is the one Staging
  // ranks on, and the rest of Staging's population for the rank. Sealed
  // candidates are identity only and are not asked about.
  let outsideTeams = { candidates: [], rows: [] };
  if (participation) {
    outsideTeams = await loadOutsideTeams(client, cycleId, known, scoreSets);
    const open = candidates.filter((candidate) => !candidate.locked);
    const everyone = [...open, ...outsideTeams.candidates];
    const points = await loadParticipationPoints({
      client,
      cycleId,
      candidates: everyone.map((candidate) => ({ candidateId: candidate.candidateId, studentId: candidate.studentId ?? candidate.application.studentId }))
    });
    for (const candidate of everyone) candidate.participationPoints = points.get(candidate.candidateId) ?? 0;
  }

  const maxByType = Object.fromEntries(DOCUMENT_TYPES.map((type) => [type, rubrics.rubrics[type].maxOverall]));
  const group = groups.find((entry) => entry.id === groupId) || null;

  return {
    groupId,
    group: group ? { id: group.id, name: groupName(group) } : null,
    groups: groups.map((entry) => ({
      id: entry.id,
      name: groupName(entry),
      members: getGroupMemberUsers(entry).map((user) => ({ id: user.id, name: user.fullName, profileImage: user.profileImage || null }))
    })),
    candidates,
    rows,
    outsideTeams,
    maxByType,
    participationMax: rubrics.participationMax,
    rubrics: rubrics.rubrics
  };
}

/**
 * Applicants in the cycle on none of its review teams. Staging ranks Resume
 * Review against every applicant in the cycle, so they count towards a rank,
 * and for nothing else: they are kept apart from `candidates` and `rows` so
 * no table, comparison, gap or outlier ever sees them. Sealed ones are left
 * out, their scores unread, as on the teams.
 */
async function loadOutsideTeams(client, cycleId, known, scoreSets) {
  const applications = await client.application.findMany({
    where: { cycleId, candidateId: { not: null, notIn: [...known] } },
    orderBy: { submittedAt: 'desc' },
    select: { id: true, candidateId: true, studentId: true, email: true }
  });
  // Latest application per person, as the team lists take.
  const latest = new Map();
  for (const application of applications) {
    if (!latest.has(application.candidateId)) latest.set(application.candidateId, application);
  }
  const people = [...latest.values()];
  const isSealed = await sealedRowPredicate(people, { client });
  const open = people.filter((application) => !isSealed(application));
  const ids = new Set(open.map((application) => application.candidateId));

  return {
    candidates: open.map((application) => ({
      candidateId: application.candidateId,
      applicationId: application.id,
      studentId: application.studentId
    })),
    rows: DOCUMENT_TYPES.flatMap((type, index) =>
      scoreSets[index].filter((row) => ids.has(row.candidateId)).map((row) => normalizeRow(row, type)))
  };
}

export const groupName = (group) => group?.name || `Team ${String(group?.id || '').slice(-4)}`;
