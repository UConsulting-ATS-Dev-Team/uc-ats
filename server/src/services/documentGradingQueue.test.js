import { describe, expect, it, vi } from 'vitest';
import { loadMemberGradingQueue } from './documentGradingQueue.js';

const cycle = { id: 'cycle-1' };
const user = (id) => ({ id, fullName: id, email: `${id}@ucla.edu`, profileImage: null });

const team = {
  id: 'group-abcd',
  name: 'Team A',
  memberOne: 'me',
  memberTwo: 'teammate',
  memberThree: null,
  memberOneUser: user('me'),
  memberTwoUser: user('teammate'),
  memberThreeUser: null,
  groupMembers: []
};

const application = (id, candidateId) => ({
  id,
  candidateId,
  firstName: 'Ada',
  lastName: 'Lovelace',
  major1: 'Math',
  graduationYear: 2027,
  cumulativeGpa: '3.90',
  status: 'SUBMITTED',
  email: `${candidateId}@ucla.edu`,
  submittedAt: new Date('2026-09-01'),
  resumeUrl: 'r',
  coverLetterUrl: null,
  shortAnswer: 'answer',
  videoUrl: null
});

// A read that stays pending until released, so a test can see which reads were
// started before any of them finished.
function deferred(value) {
  let release;
  const promise = new Promise((resolve) => { release = () => resolve(value); });
  return { fn: vi.fn(() => promise), release };
}

function fakeClient({ groups = [team], candidates, resume = [], coverLetter = [], video = [], flags = [] }) {
  return {
    groups: { findMany: vi.fn().mockResolvedValue(groups) },
    candidate: { findMany: vi.fn().mockResolvedValue(candidates) },
    resumeScore: { findMany: vi.fn().mockResolvedValue(resume) },
    coverLetterScore: { findMany: vi.fn().mockResolvedValue(coverLetter) },
    videoScore: { findMany: vi.fn().mockResolvedValue(video) },
    flaggedDocument: { findMany: vi.fn().mockResolvedValue(flags) }
  };
}

const candidates = [
  { id: 'cand-1', studentId: '111', assignedGroupId: team.id, applications: [application('app-1', 'cand-1')] },
  { id: 'cand-2', studentId: '222', assignedGroupId: team.id, applications: [application('app-2', 'cand-2')] }
];

describe('loadMemberGradingQueue', () => {
  it("marks the evaluator's own grades and counts the team's separately", async () => {
    const client = fakeClient({
      candidates,
      resume: [
        { candidateId: 'cand-1', evaluatorId: 'me', assignedGroupId: team.id },
        { candidateId: 'cand-2', evaluatorId: 'teammate', assignedGroupId: team.id }
      ],
      flags: [{ applicationId: 'app-2', documentType: 'resume', reason: 'blank' }]
    });

    const rows = await loadMemberGradingQueue(client, { cycle, memberId: 'me', evaluatorId: 'me' });

    expect(rows.map(r => [r.id, r.hasResumeScore, r.resumeMissingGrades])).toEqual([
      ['app-1', true, 1],
      ['app-2', false, 1]
    ]);
    expect(rows[1].resumeCompletedEvaluators).toEqual(['teammate']);
    expect(rows[1].resumeFlagged).toMatchObject({ reason: 'blank' });
    expect(rows[0].resumeFlagged).toBeNull();
    expect(rows[0]).toMatchObject({ studentId: '111', cycleId: 'cycle-1', groupName: 'Team abcd', gpa: '3.90' });
  });

  it('never reads the raw form submission', async () => {
    const client = fakeClient({ candidates });
    await loadMemberGradingQueue(client, { cycle, memberId: 'me', evaluatorId: 'me' });

    const { select } = client.candidate.findMany.mock.calls[0][0].select.applications;
    expect(select).toMatchObject({ id: true, shortAnswer: true, resumeUrl: true });
    expect(select.rawResponses).toBeUndefined();
  });

  it('starts the team and candidate reads together, then the four grading reads together', async () => {
    const groups = deferred([team]);
    const cands = deferred(candidates);
    const client = fakeClient({ candidates });
    client.groups.findMany = groups.fn;
    client.candidate.findMany = cands.fn;
    const scoreReads = ['resumeScore', 'coverLetterScore', 'videoScore', 'flaggedDocument'].map((model) => {
      const read = deferred([]);
      client[model].findMany = read.fn;
      return read;
    });

    const pending = loadMemberGradingQueue(client, { cycle, memberId: 'me', evaluatorId: 'me' });
    await Promise.resolve();
    expect(groups.fn).toHaveBeenCalled();
    expect(cands.fn).toHaveBeenCalled();
    expect(scoreReads[0].fn).not.toHaveBeenCalled();

    groups.release();
    cands.release();
    await vi.waitFor(() => scoreReads.forEach(read => expect(read.fn).toHaveBeenCalled()));
    scoreReads.forEach(read => read.release());

    expect(await pending).toHaveLength(2);
  });

  it('finds candidates through the same team filter as the groups', async () => {
    const client = fakeClient({ candidates });
    await loadMemberGradingQueue(client, { cycle, memberId: 'me', evaluatorId: 'me' });

    const groupWhere = client.groups.findMany.mock.calls[0][0].where;
    expect(client.candidate.findMany.mock.calls[0][0].where).toEqual({ assignedGroup: { is: groupWhere } });
    expect(groupWhere.cycleId).toBe('cycle-1');
  });

  it('returns nothing, and reads no scores, when the member is on no team', async () => {
    const client = fakeClient({ groups: [], candidates: [] });
    expect(await loadMemberGradingQueue(client, { cycle, memberId: 'me', evaluatorId: 'me' })).toEqual([]);
    expect(client.resumeScore.findMany).not.toHaveBeenCalled();
  });

  it('skips a candidate with no application in the cycle', async () => {
    const client = fakeClient({
      candidates: [...candidates, { id: 'cand-3', studentId: '333', assignedGroupId: team.id, applications: [] }]
    });
    const rows = await loadMemberGradingQueue(client, { cycle, memberId: 'me', evaluatorId: 'me' });
    expect(rows.map(r => r.candidateId)).toEqual(['cand-1', 'cand-2']);
  });
});
