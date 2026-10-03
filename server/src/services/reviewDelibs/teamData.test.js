// What loadTeamInput reads for the rank: Staging ranks Resume Review against
// every applicant in the cycle, so applicants on no review team are loaded too,
// apart from the team lists, and never their sealed ones.
import { describe, it, expect, vi } from 'vitest';
import { loadTeamInput } from './teamData.js';

vi.mock('../../prismaClient.js', () => ({ default: {} }));

const app = (id, candidateId, studentId) => ({
  id, candidateId, cycleId: 'cycle-1', firstName: 'Cand', lastName: id, email: `${candidateId}@ucla.edu`, studentId,
  resumeUrl: '/r', coverLetterUrl: null, shortAnswer: null, videoUrl: null, resumeDecision: null, submittedAt: new Date()
});
const score = (id, candidateId, evaluatorId, overallScore) =>
  ({ id, candidateId, evaluatorId, overallScore, adminScore: null, evaluator: { fullName: evaluatorId } });

function fakeClient() {
  return {
    groups: {
      findMany: vi.fn(async () => [{
        id: 'g1', name: 'Team Alpha', memberOneUser: { id: 'm1', fullName: 'Mia' }, groupMembers: [],
        assignedCandidates: [{ id: 'c1', email: 'c1@ucla.edu', studentId: '1', applications: [app('a1', 'c1', '1')] }]
      }])
    },
    documentRubric: { findMany: vi.fn(async () => []) },
    resumeScore: {
      findMany: vi.fn(async () => [score('s1', 'c1', 'm1', 8), score('s2', 'u1', 'x', 10), score('s3', 'sealed', 'x', 13)])
    },
    coverLetterScore: { findMany: vi.fn(async () => []) },
    videoScore: { findMany: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => [{ id: 'm1', email: 'mia@ucla.edu', studentId: null }]) },
    candidate: {
      findMany: vi.fn(async ({ where }) => (where.OR.some((clause) => clause.id?.in?.includes('sealed'))
        ? [{ id: 'sealed', studentId: '9', email: 'sealed@ucla.edu' }]
        : []))
    },
    // Latest first, as asked: u1's newer application is the one kept.
    application: {
      findMany: vi.fn(async () => [app('u1-new', 'u1', '7'), app('u1-old', 'u1', '7'), app('s-app', 'sealed', '9')])
    },
    recruitingCycle: { findUnique: vi.fn(async () => ({ startDate: null, endDate: null })) },
    eventAttendance: { findMany: vi.fn(async () => [{ candidateId: 'u1', eventId: 'e1' }]) },
    meetingSignup: { findMany: vi.fn(async () => []) }
  };
}

describe('loadTeamInput', () => {
  it('loads applicants on no team for the rank only, without the sealed', async () => {
    const client = fakeClient();
    const input = await loadTeamInput({ client, groupId: 'g1', cycleId: 'cycle-1' });

    expect(client.application.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { cycleId: 'cycle-1', candidateId: { not: null, notIn: ['c1'] } }
    }));
    expect(input.candidates.map((entry) => entry.candidateId)).toEqual(['c1']);
    expect(input.rows.map((row) => row.candidateId)).toEqual(['c1']);
    expect(input.outsideTeams.candidates).toEqual([
      { candidateId: 'u1', applicationId: 'u1-new', studentId: '7', participationPoints: 1 }
    ]);
    expect(input.outsideTeams.rows.map((row) => row.candidateId)).toEqual(['u1']);
    // Participation is asked for the team and the rest, never the sealed.
    expect(client.eventAttendance.findMany.mock.calls[0][0].where.candidateId.in).toEqual(['c1', 'u1']);
  });

  it('reads none of it for the walkthrough', async () => {
    const client = fakeClient();
    const input = await loadTeamInput({ client, groupId: 'g1', cycleId: 'cycle-1', participation: false });
    expect(input.outsideTeams).toEqual({ candidates: [], rows: [] });
    expect(client.application.findMany).not.toHaveBeenCalled();
    expect(client.eventAttendance.findMany).not.toHaveBeenCalled();
  });
});
