import prisma from '../../prismaClient.js';
import { DOCUMENT_TYPES, getRubrics } from '../documentRubrics.js';
import { getGroupMemberUsers, groupMemberUserInclude } from '../../utils/groupMembers.js';
import { sealedRowPredicate } from '../../utils/lockedRecords.js';
import { hasCoverLetter } from '../../utils/coverLetter.js';
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

/** The input computeTeamStats() takes, for `groupId`'s cycle. */
export async function loadTeamInput({ client = prisma, groupId, cycleId }) {
  const [groups, rubrics, ...scoreSets] = await Promise.all([
    client.groups.findMany({
      where: { cycleId },
      include: {
        ...groupMemberUserInclude,
        assignedCandidates: {
          select: {
            id: true,
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

  const candidates = [];
  for (const group of groups) {
    for (const candidate of group.assignedCandidates) {
      const application = candidate.applications[0];
      if (!application) continue;
      candidates.push({
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
    maxByType,
    rubrics: rubrics.rubrics
  };
}

export const groupName = (group) => group?.name || `Team ${String(group?.id || '').slice(-4)}`;
