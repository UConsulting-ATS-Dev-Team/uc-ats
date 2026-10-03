import { describe, expect, it } from 'vitest';
import {
  annotateOutliers,
  buildInsights,
  completeness,
  computeTeamStats,
  graderSummaries,
  normalizeRow,
  outlierOrder,
  rankOverall,
  rethresholdWalkthrough,
  teamComparison,
  docAverages
} from './teamStats.js';

const MAX = { resume: 13, coverLetter: 3, video: 2 };

// A Prisma Decimal's valueOf() is a string; the old outlier code added these as strings.
const decimal = (value) => ({ valueOf: () => String(value), toString: () => String(value) });

let nextId = 0;
const row = (candidateId, evaluatorId, type, overall, admin = null) =>
  normalizeRow({
    id: `s${++nextId}`,
    candidateId,
    evaluatorId,
    evaluator: { fullName: evaluatorId.toUpperCase() },
    overallScore: overall === null ? null : decimal(overall),
    adminScore: admin === null ? null : decimal(admin)
  }, type);

const byScore = (rows) => Object.fromEntries(rows.map((entry) => [entry.evaluatorId, entry]));

describe('normalizeRow', () => {
  it('turns Decimals into numbers and prefers the admin override', () => {
    const graded = row('c1', 'a', 'resume', 8);
    expect(graded.overall).toBe(8);
    expect(graded.effective).toBe(8);

    const overridden = row('c1', 'a', 'resume', 4, 9);
    expect(overridden.overall).toBe(4);
    expect(overridden.admin).toBe(9);
    expect(overridden.effective).toBe(9);
  });
});

describe('annotateOutliers', () => {
  it('flags a grader far from the mean of the other graders', () => {
    // 30% of 13 = 3.9. a=3 vs others' mean 9 -> outlier; b=9 vs mean of (3, 9) = 6 -> 3 away, not.
    const rows = annotateOutliers([row('c1', 'a', 'resume', 3), row('c1', 'b', 'resume', 9), row('c1', 'c', 'resume', 9)], { maxByType: MAX });
    const scores = byScore(rows);
    expect(scores.a.isOutlier).toBe(true);
    expect(scores.a.othersMean).toBe(9);
    expect(scores.a.deviation).toBe(-6);
    expect(scores.b.isOutlier).toBe(false);
    expect(scores.c.isOutlier).toBe(false);
  });

  it('counts a gap of exactly the threshold as an outlier', () => {
    // video max 2, threshold 0.5 -> limit 1. a=0 vs others' mean 1.
    const rows = annotateOutliers([row('c1', 'a', 'video', 0), row('c1', 'b', 'video', 1), row('c1', 'c', 'video', 1)], { maxByType: MAX, thresholdPct: 0.5 });
    expect(byScore(rows).a.isOutlier).toBe(true);
  });

  it('marks a wide gap between two graders as a split on both, an outlier on neither', () => {
    const rows = annotateOutliers([row('c1', 'a', 'resume', 2), row('c1', 'b', 'resume', 11)], { maxByType: MAX });
    for (const entry of rows) {
      expect(entry.split).toBe(true);
      expect(entry.isOutlier).toBe(false);
    }
  });

  it('does not flag the two graders who agree when one is far off', () => {
    // Each 10 sits 4 above the mean of (2, 10) - over the 3.9 limit - but 2 is the one that is off.
    const rows = annotateOutliers([row('c1', 'a', 'resume', 2), row('c1', 'b', 'resume', 10), row('c1', 'c', 'resume', 10)], { maxByType: MAX });
    const scores = byScore(rows);
    expect(scores.a.isOutlier).toBe(true);
    expect(scores.b.flag).toBe(null);
    expect(scores.c.flag).toBe(null);
  });

  it('calls an even spread a split rather than picking one end', () => {
    const rows = annotateOutliers([row('c1', 'a', 'resume', 2), row('c1', 'b', 'resume', 6), row('c1', 'c', 'resume', 10)], { maxByType: MAX });
    const scores = byScore(rows);
    expect(scores.a.split).toBe(true);
    expect(scores.c.split).toBe(true);
    expect(scores.b.flag).toBe(null);
  });

  it('flags nothing on a document with one grade', () => {
    const [only] = annotateOutliers([row('c1', 'a', 'resume', 0)], { maxByType: MAX });
    expect(only.flag).toBe(null);
    expect(only.othersMean).toBe(null);
  });

  it('resolves an outlier once an admin overrides it, and remembers it was one', () => {
    const rows = annotateOutliers([row('c1', 'a', 'resume', 3, 9), row('c1', 'b', 'resume', 9), row('c1', 'c', 'resume', 9)], { maxByType: MAX });
    const { a } = byScore(rows);
    expect(a.isOutlier).toBe(false);
    expect(a.rawFlag).toBe('outlier');
  });

  it('compares documents separately', () => {
    const rows = annotateOutliers([
      row('c1', 'a', 'resume', 3), row('c1', 'b', 'resume', 9), row('c1', 'c', 'resume', 9),
      row('c2', 'a', 'resume', 9), row('c2', 'b', 'resume', 9), row('c2', 'c', 'resume', 9)
    ], { maxByType: MAX });
    expect(rows.filter((entry) => entry.isOutlier)).toHaveLength(1);
  });
});

describe('graderSummaries', () => {
  it('measures bias against teammates on the same documents', () => {
    const rows = annotateOutliers([
      row('c1', 'a', 'resume', 5), row('c1', 'b', 'resume', 8), row('c1', 'c', 'resume', 8),
      row('c2', 'a', 'resume', 2), row('c2', 'b', 'resume', 5), row('c2', 'c', 'resume', 5)
    ], { maxByType: MAX });
    const members = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }, { id: 'd', name: 'D' }];
    const summaries = Object.fromEntries(graderSummaries(rows, members).map((entry) => [entry.id, entry]));

    expect(summaries.a.bias.resume.points).toBe(-3);
    expect(summaries.a.bias.resume.docs).toBe(2);
    expect(summaries.d.gradedTotal).toBe(0);
    expect(summaries.d.bias.resume).toBe(null);
  });

  it('measures lean against teammates only, not graders from outside the team', () => {
    // Two teammates agree on 10; an admin's 2 must not make them look generous.
    const rows = annotateOutliers([row('c1', 'a', 'resume', 10), row('c1', 'b', 'resume', 10), row('c1', 'admin', 'resume', 2)], { maxByType: MAX });
    const summaries = Object.fromEntries(graderSummaries(rows, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }], MAX).map((entry) => [entry.id, entry]));
    expect(summaries.a.bias.resume).toEqual({ points: 0, pct: 0, docs: 1 });
    expect(summaries.b.bias.resume.points).toBe(0);
    expect(summaries.admin.bias.resume.points).toBe(-8);
  });

  it('lists a grader from outside the team, marked as such', () => {
    const rows = annotateOutliers([row('c1', 'a', 'resume', 5), row('c1', 'admin', 'resume', 6)], { maxByType: MAX });
    const summaries = graderSummaries(rows, [{ id: 'a', name: 'A' }]);
    expect(summaries.find((entry) => entry.id === 'admin').onTeam).toBe(false);
  });
});

describe('teamComparison', () => {
  it('compares the team with the rest of the cycle and ranks it', () => {
    const rows = [
      row('t1', 'a', 'resume', 4), row('t2', 'a', 'resume', 6), // team g1: mean 5
      row('o1', 'x', 'resume', 9), row('o2', 'x', 'resume', 11), // g2: mean 10
      row('p1', 'y', 'resume', 7) // g3: mean 7
    ];
    const teamOf = new Map([['t1', 'g1'], ['t2', 'g1'], ['o1', 'g2'], ['o2', 'g2'], ['p1', 'g3']]);
    const groups = [{ id: 'g1', name: 'One' }, { id: 'g2', name: 'Two' }, { id: 'g3', name: 'Three' }];
    const { resume } = teamComparison({ averages: docAverages(rows), teamOf, groupId: 'g1', groups, maxByType: MAX });

    expect(resume.team.mean).toBe(5);
    expect(resume.rest.mean).toBe(9); // (9 + 11 + 7) / 3
    expect(resume.delta).toBe(-4);
    expect(resume.rank).toBe(1);
    expect(resume.of).toBe(3);
  });

  it('averages each document before averaging the team', () => {
    // c1 graded by three people at 3, c2 by one at 9: the team mean is 6, not 4.5.
    const rows = [row('c1', 'a', 'resume', 3), row('c1', 'b', 'resume', 3), row('c1', 'c', 'resume', 3), row('c2', 'a', 'resume', 9)];
    const teamOf = new Map([['c1', 'g1'], ['c2', 'g1']]);
    const { resume } = teamComparison({ averages: docAverages(rows), teamOf, groupId: 'g1', groups: [{ id: 'g1', name: 'One' }], maxByType: MAX });
    expect(resume.team.mean).toBe(6);
    expect(resume.rest.mean).toBe(null);
    expect(resume.delta).toBe(null);
  });
});

describe('completeness', () => {
  it('counts only documents the candidate submitted', () => {
    const candidates = [{ candidateId: 'c1', applicationId: 'app1', hasDoc: { resume: true, coverLetter: false, video: true }, resumeDecision: null }];
    const gaps = completeness({ candidates, memberIds: ['a', 'b'], rows: [row('c1', 'a', 'resume', 5)] });

    expect(gaps.missingCount).toBe(3); // b on resume, a and b on video; no cover letter to grade
    expect(gaps.singleGrader).toEqual([{ applicationId: 'app1', type: 'resume' }]);
    expect(gaps.undecided).toEqual(['app1']);
  });

  it("does not owe a member a grade on their own application", () => {
    const candidates = [{
      candidateId: 'c1', applicationId: 'app1', hasDoc: { resume: true, coverLetter: false, video: false },
      resumeDecision: 'yes', excludedGraderIds: ['b']
    }];
    const gaps = completeness({ candidates, memberIds: ['a', 'b'], rows: [row('c1', 'a', 'resume', 5)] });
    expect(gaps.missingCount).toBe(0);
  });
});

describe('buildInsights', () => {
  const comparison = (overrides = {}) => ({
    resume: { delta: null, deltaPct: null, rank: null, of: 0, ...overrides.resume },
    coverLetter: { delta: null, deltaPct: null, rank: null, of: 0, ...overrides.coverLetter },
    video: { delta: null, deltaPct: null, rank: null, of: 0, ...overrides.video }
  });
  const noOutliers = { outlierGrades: 0, splits: 0, scoredDocs: 4 };

  it('says nothing at all with no grades', () => {
    expect(buildInsights({ comparison: comparison(), graders: [], counts: { outlierGrades: 0, splits: 0, scoredDocs: 0 } })).toEqual([]);
  });

  it('describes a team-wide lean in points and share of max, with its rank', () => {
    const [insight] = buildInsights({
      comparison: comparison({ resume: { delta: -1.8, deltaPct: -0.1385, rank: 1, of: 6 } }),
      graders: [],
      counts: noOutliers
    });
    expect(insight.text).toBe('Grades resumes 1.8 pts harsher than the rest of the cycle (14% of max), the harshest of 6 teams.');
  });

  it('ignores a lean too small to matter', () => {
    const insights = buildInsights({ comparison: comparison({ resume: { delta: 0.3, deltaPct: 0.02, rank: 2, of: 3 } }), graders: [], counts: noOutliers });
    expect(insights.map((entry) => entry.id)).toEqual(['aligned']);
  });

  it('names the grader behind most of the outliers', () => {
    const graders = [{
      id: 'a', name: 'Jordan', onTeam: true, outlierCount: 5, outliersHigh: 4,
      outliersByType: { resume: 1, coverLetter: 4, video: 0 },
      bias: { resume: null, coverLetter: null, video: null }
    }];
    const insights = buildInsights({ comparison: comparison(), graders, counts: { outlierGrades: 8, splits: 0, scoredDocs: 10 } });
    expect(insights[0].text).toBe('Jordan had 5 of 8 outliers, mostly high on cover letters.');
  });

  it('keeps the four biggest, largest first', () => {
    const grader = (id, pct) => ({
      id, name: id, onTeam: true, outlierCount: 0, outliersHigh: 0, outliersByType: { resume: 0, coverLetter: 0, video: 0 },
      bias: { resume: { points: pct * 13, pct, docs: 5 }, coverLetter: null, video: null }
    });
    const insights = buildInsights({
      comparison: comparison(),
      graders: [grader('a', 0.11), grader('b', -0.4), grader('c', 0.2), grader('d', 0.15), grader('e', 0.3)],
      counts: noOutliers
    });
    expect(insights.map((entry) => entry.id)).toEqual(['bias-b-resume', 'bias-e-resume', 'bias-c-resume', 'bias-d-resume']);
  });
});

describe('computeTeamStats', () => {
  const groups = [
    { id: 'g1', name: 'One', members: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }] },
    { id: 'g2', name: 'Two', members: [{ id: 'x', name: 'X' }] }
  ];
  const candidate = (candidateId, groupId, extra = {}) => ({
    candidateId,
    applicationId: `app-${candidateId}`,
    groupId,
    name: candidateId,
    hasDoc: { resume: true, coverLetter: false, video: false },
    resumeDecision: null,
    locked: false,
    ...extra
  });

  const stats = computeTeamStats({
    groupId: 'g1',
    maxByType: MAX,
    groups,
    candidates: [candidate('c1', 'g1'), candidate('c2', 'g1'), candidate('c3', 'g1', { locked: true }), candidate('o1', 'g2')],
    rows: [
      row('c1', 'a', 'resume', 2), row('c1', 'b', 'resume', 10), row('c1', 'c', 'resume', 10),
      row('c2', 'a', 'resume', 6), row('c2', 'b', 'resume', 12),
      row('o1', 'x', 'resume', 9)
    ]
  });

  it('keeps a sealed candidate as a name only, out of every number', () => {
    const sealed = stats.candidates.find((entry) => entry.candidateId === 'c3');
    expect(Object.keys(sealed).sort()).toEqual(['applicationId', 'candidateId', 'locked', 'name']);
    expect(stats.counts.candidates).toBe(3);
    expect(stats.counts.sealed).toBe(1);
  });

  it('counts outliers and splits on the team only', () => {
    expect(stats.counts.outlierGrades).toBe(1);
    expect(stats.counts.splits).toBe(1);
    expect(stats.rows.every((entry) => entry.candidateId !== 'o1')).toBe(true);
  });

  it('orders the walkthrough by widest disagreement', () => {
    // c1: a is 8 below -> 62% of max. c2: split of 6 -> 3 each side, 23%.
    expect(outlierOrder(stats)).toEqual(['app-c1', 'app-c2']);
  });

  it('flags what needs correcting, naming the candidates', () => {
    expect(stats.flags.map((flag) => flag.id)).toEqual(['outliers', 'splits', 'missing', 'undecided']);
    expect(stats.flags[0].applicationIds).toEqual(['app-c1']);
  });

  it("adds participation to the documents total for Staging's overall, 0 when absent", () => {
    const withPoints = computeTeamStats({
      groupId: 'g1',
      maxByType: MAX,
      participationMax: 3,
      groups,
      candidates: [candidate('c1', 'g1', { participationPoints: 2 }), candidate('c2', 'g1')],
      rows: [row('c1', 'a', 'resume', 2), row('c1', 'b', 'resume', 10), row('c1', 'c', 'resume', 10), row('c2', 'a', 'resume', 6)]
    });
    const [c1, c2] = withPoints.candidates;
    // 22 / 3 = 7.333..., plus 2, rounded to one place as Staging rounds it.
    expect(c1).toMatchObject({ total: 7.33, participation: 2, overall: 9.3 });
    expect(c2).toMatchObject({ total: 6, participation: 0, overall: 6 });
    expect(withPoints).toMatchObject({ participationMax: 3, overallMax: 13 + 3 + 2 + 3 });

    // The tutorial capture passes neither.
    expect(stats.candidates[0]).toMatchObject({ participation: 0, overall: 7.3 });
    expect(stats).toMatchObject({ participationMax: null, overallMax: null });
  });
});

describe('rethresholdWalkthrough', () => {
  const groups = [{ id: 'g1', name: 'One', members: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }, { id: 'c', name: 'C' }] }];
  const candidate = (candidateId, extra = {}) => ({
    candidateId, applicationId: `app-${candidateId}`, groupId: 'g1', name: candidateId,
    hasDoc: { resume: true, coverLetter: false, video: false }, resumeDecision: null, locked: false, ...extra
  });
  const at = (thresholdPct, rows, candidates = [candidate('c1'), candidate('c2'), candidate('c3')]) =>
    computeTeamStats({ groupId: 'g1', thresholdPct, maxByType: MAX, groups, candidates, rows });
  // c1: 2 / 10 / 10 (8 away, 62% of max). c2: 6 / 12 (a 6-point split, 46%). c3: 4 / 6 / 6 (2 away, 15%).
  const rows = () => [
    row('c1', 'a', 'resume', 2), row('c1', 'b', 'resume', 10), row('c1', 'c', 'resume', 10),
    row('c2', 'a', 'resume', 6), row('c2', 'b', 'resume', 12),
    row('c3', 'a', 'resume', 4), row('c3', 'b', 'resume', 6), row('c3', 'c', 'resume', 6)
  ];

  it('drops entries that no longer qualify and keeps the rest in their order', () => {
    // Kept order wins over outlierOrder's, which would put app-c1 first.
    expect(rethresholdWalkthrough(at(0.2, rows()), ['app-c2', 'app-c3', 'app-c1'])).toEqual(['app-c2', 'app-c1']);
    expect(rethresholdWalkthrough(at(0.5, rows()), ['app-c1', 'app-c2', 'app-c3'])).toEqual(['app-c1']);
  });

  it('appends newly qualifying candidates when the threshold drops', () => {
    expect(rethresholdWalkthrough(at(0.1, rows()), ['app-c2'])).toEqual(['app-c2', 'app-c1', 'app-c3']);
  });

  it('keeps an entry whose outlier an override resolved, but adds none on graded scores alone', () => {
    const resolved = [row('c1', 'a', 'resume', 2, 10), row('c1', 'b', 'resume', 10), row('c1', 'c', 'resume', 10)];
    expect(rethresholdWalkthrough(at(0.3, resolved), ['app-c1'])).toEqual(['app-c1']);
    expect(rethresholdWalkthrough(at(0.3, resolved), [])).toEqual([]);
  });

  it('leaves sealed and moved candidates for the walk to skip', () => {
    const stats = at(0.5, rows(), [candidate('c1'), candidate('c2', { locked: true })]);
    expect(rethresholdWalkthrough(stats, ['app-c2', 'app-gone', 'app-c1'])).toEqual(['app-c2', 'app-gone', 'app-c1']);
  });
});

describe('rank', () => {
  it("is Staging's rule: highest first, ties share and the next skips, 0 unranked", () => {
    const { ranks, rankedCount } = rankOverall(new Map([['a', 9], ['b', 12], ['c', 9], ['d', 5], ['e', 0], ['f', 9]]));
    expect(Object.fromEntries(ranks)).toEqual({ b: 1, a: 2, c: 2, f: 2, d: 5 });
    expect(rankedCount).toBe(5);
  });

  const groups = [
    { id: 'g1', name: 'One', members: [{ id: 'a', name: 'A' }] },
    { id: 'g2', name: 'Two', members: [{ id: 'x', name: 'X' }] }
  ];
  const candidate = (candidateId, groupId, extra = {}) => ({
    candidateId, applicationId: `app-${candidateId}`, groupId, name: candidateId,
    hasDoc: { resume: true, coverLetter: false, video: false }, resumeDecision: null, locked: false, ...extra
  });
  const stats = computeTeamStats({
    groupId: 'g1',
    maxByType: MAX,
    groups,
    candidates: [
      candidate('t1', 'g1', { participationPoints: 1 }), // 8 + 1 = 9
      candidate('t2', 'g1'), // ungraded: 0, unranked
      candidate('t3', 'g1', { locked: true }), // sealed: no scores read, unranked
      candidate('o1', 'g2') // 11
    ],
    rows: [row('t1', 'a', 'resume', 8), row('o1', 'x', 'resume', 11)],
    outsideTeams: {
      candidates: [{ candidateId: 'u1', participationPoints: 2 }, { candidateId: 'u2', participationPoints: 0 }],
      rows: [row('u1', 'z', 'resume', 10), row('u2', 'z', 'resume', 9)] // 12, and 9 ties t1
    }
  });
  const byId = Object.fromEntries(stats.candidates.map((entry) => [entry.candidateId, entry]));

  it('ranks the team against every candidate in the cycle, on a team or none', () => {
    expect(byId.t1).toMatchObject({ overall: 9, rank: 3 }); // behind u1 (12) and o1 (11), level with u2
    expect(stats.rankedCount).toBe(4);
  });

  it('leaves ungraded and sealed candidates unranked', () => {
    expect(byId.t2).toMatchObject({ overall: 0, rank: null });
    expect(byId.t3).not.toHaveProperty('rank');
  });

  it('keeps candidates outside the teams out of everything but the rank', () => {
    expect(stats.candidates.map((entry) => entry.candidateId)).toEqual(['t1', 't2', 't3']);
    expect(stats.rows.every((entry) => entry.candidateId.startsWith('t'))).toBe(true);
    expect(stats.counts.candidates).toBe(3);
    // The rest of the cycle, for the comparison, is o1 alone.
    expect(stats.comparison.resume.rest.mean).toBe(11);
    expect(stats.graders.map((grader) => grader.id)).toEqual(['a']);
  });

  it('ranks without them when none are passed, as the tutorial capture does', () => {
    const alone = computeTeamStats({ groupId: 'g1', maxByType: MAX, groups, candidates: [candidate('t1', 'g1'), candidate('o1', 'g2')], rows: [row('t1', 'a', 'resume', 8), row('o1', 'x', 'resume', 11)] });
    expect(alone.candidates[0].rank).toBe(2);
    expect(alone.rankedCount).toBe(2);
  });
});
