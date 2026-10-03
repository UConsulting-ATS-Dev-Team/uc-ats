// The numbers behind a review team deliberation. Pure: the loader in
// teamData.js reads the database, this file only does arithmetic, so every rule
// below is pinned by teamStats.test.js without a database.
//
// It imports nothing on purpose. The tutorial capture (video/scripts/flows/
// review-delibs.mjs) runs it outside the server to compute what the sample
// team's overview shows, and documentRubrics.js would drag Prisma in with it.
// DOCUMENT_TYPES and formatScore match the ones there.
//
// A grader's score on one document is its *effective* score: the admin override
// when there is one, otherwise what they graded. That is what Staging ranks on,
// so an override made during a deliberation shows here as a resolved outlier.
//
// An outlier is a score far from what the *other* graders gave the same
// document - far meaning at least `thresholdPct` of the document type's maximum
// - and further from them than anyone else's (see compare()). When there is no
// telling which grader is off - two graders, or three spread evenly - a wide
// gap is a *split*, shown on everyone involved and blamed on nobody. With one
// grader there is nothing to compare.

export const DEFAULT_THRESHOLD_PCT = 0.3;
export const MIN_THRESHOLD_PCT = 0.1;
export const MAX_THRESHOLD_PCT = 0.6;

const DOCUMENT_TYPES = Object.freeze(['resume', 'coverLetter', 'video']);
const formatScore = (value) => String(Math.round(value * 100) / 100);

const MAX_INSIGHTS = 4;
// Below these, a difference is noise and not worth a line on the overview.
const TEAM_DELTA_MIN_PCT = 0.05;
const GRADER_BIAS_MIN_PCT = 0.1;
const GRADER_BIAS_MIN_DOCS = 3;
const EPSILON = 1e-9;

const PLURAL = { resume: 'resumes', coverLetter: 'cover letters', video: 'videos' };
const SINGULAR = { resume: 'resume', coverLetter: 'cover letter', video: 'video' };

const toNumber = (value) => (value === null || value === undefined || value === '' ? null : Number(value));
const mean = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const round = (value, places = 2) => (value === null ? null : Math.round(value * 10 ** places) / 10 ** places);
const percent = (fraction) => `${Math.round(Math.abs(fraction) * 100)}%`;
const docKey = (candidateId, type) => `${candidateId}:${type}`;

/** One score row from any of the three score tables, with Decimals as numbers. */
export function normalizeRow(row, type) {
  const overall = toNumber(row.overallScore);
  const admin = toNumber(row.adminScore);
  return {
    scoreId: row.id,
    type,
    candidateId: row.candidateId,
    evaluatorId: row.evaluatorId ?? null,
    evaluatorName: row.evaluator?.fullName || 'Unknown grader',
    overall,
    admin,
    effective: admin ?? overall,
    categories: { scoreOne: row.scoreOne ?? null, scoreTwo: row.scoreTwo ?? null, scoreThree: row.scoreThree ?? null },
    notes: row.notes ?? row.notesOne ?? null,
    adminNotes: row.adminNotes ?? null
  };
}

/**
 * For each value, how it sits against the mean of the others, and whether that
 * makes it an outlier or part of a split.
 *
 * Only the value furthest from the others can be the outlier. One low score
 * pulls the others' mean down for everyone else too - 2, 10, 10 puts each 10
 * four points above the mean of (2, 10) - so "far from the others" alone would
 * flag the two graders who agree. When several tie for furthest (2, 6, 10, or
 * any pair) nobody is singled out: that is a split.
 */
function compare(values, limit) {
  if (values.length < 2) return values.map(() => ({ othersMean: null, deviation: null, flag: null }));
  const entries = values.map((value, index) => {
    const othersMean = mean(values.filter((_, other) => other !== index));
    return { othersMean, deviation: value - othersMean };
  });
  const widest = Math.max(...entries.map((entry) => Math.abs(entry.deviation)));
  if (widest < limit - EPSILON) return entries.map((entry) => ({ ...entry, flag: null }));

  const furthest = entries.filter((entry) => Math.abs(entry.deviation) >= widest - EPSILON);
  const flag = furthest.length === 1 ? 'outlier' : 'split';
  return entries.map((entry) => ({ ...entry, flag: furthest.includes(entry) ? flag : null }));
}

/**
 * Annotates every row with where it sits against the other graders of the same
 * document. `rawFlag` is the same check on the graded score, ignoring overrides,
 * so a card can say "was an outlier, resolved".
 */
export function annotateOutliers(rows, { maxByType, thresholdPct = DEFAULT_THRESHOLD_PCT }) {
  const byDoc = new Map();
  for (const row of rows) {
    if (row.effective === null) continue;
    const key = docKey(row.candidateId, row.type);
    if (!byDoc.has(key)) byDoc.set(key, []);
    byDoc.get(key).push(row);
  }

  const annotated = [];
  for (const docRows of byDoc.values()) {
    const max = maxByType[docRows[0].type] || 1;
    const limit = thresholdPct * max;
    const effective = compare(docRows.map((row) => row.effective), limit);
    const raw = compare(docRows.map((row) => row.overall ?? row.effective), limit);
    docRows.forEach((row, index) => {
      const { othersMean, deviation, flag } = effective[index];
      annotated.push({
        ...row,
        othersMean: round(othersMean),
        deviation: round(deviation),
        deviationPct: deviation === null ? null : round(deviation / max, 4),
        flag,
        isOutlier: flag === 'outlier',
        split: flag === 'split',
        rawFlag: raw[index].flag,
        graderCount: docRows.length
      });
    });
  }
  return annotated;
}

/** Each candidate-document's mean effective score: the per-document average Staging adds up. */
export function docAverages(rows) {
  const byDoc = new Map();
  for (const row of rows) {
    if (row.effective === null) continue;
    const key = docKey(row.candidateId, row.type);
    if (!byDoc.has(key)) byDoc.set(key, { candidateId: row.candidateId, type: row.type, values: [] });
    byDoc.get(key).values.push(row.effective);
  }
  return [...byDoc.values()].map(({ candidateId, type, values }) => ({
    candidateId,
    type,
    avg: mean(values),
    n: values.length
  }));
}

/**
 * Everyone who graded the team's candidates, plus team members who graded
 * nothing. Bias ("lean") is the mean of (score - the team members' mean) over
 * the same documents, so a grader who drew a strong pile is not called generous
 * for it. Only team members count as the comparison: the page calls this a
 * lean against teammates, and an admin's grade on the same document is not a
 * teammate's. Outlier and split flags still compare against every grader.
 */
export function graderSummaries(rows, members, maxByType = {}) {
  const memberIds = new Set(members.map((member) => member.id));
  const teammatesOn = new Map();
  for (const row of rows) {
    if (!memberIds.has(row.evaluatorId) || row.effective === null) continue;
    const key = docKey(row.candidateId, row.type);
    if (!teammatesOn.has(key)) teammatesOn.set(key, []);
    teammatesOn.get(key).push(row);
  }
  const leanOf = (row) => {
    const others = (teammatesOn.get(docKey(row.candidateId, row.type)) || []).filter((other) => other.scoreId !== row.scoreId);
    if (!others.length || row.effective === null) return null;
    return row.effective - mean(others.map((other) => other.effective));
  };
  const graders = new Map(members.map((member) => [member.id, { id: member.id, name: member.name, onTeam: true }]));
  for (const row of rows) {
    if (!row.evaluatorId || graders.has(row.evaluatorId)) continue;
    graders.set(row.evaluatorId, { id: row.evaluatorId, name: row.evaluatorName, onTeam: false });
  }

  return [...graders.values()].map((grader) => {
    const mine = rows.filter((row) => row.evaluatorId === grader.id);
    const graded = {};
    const bias = {};
    for (const type of DOCUMENT_TYPES) {
      const ofType = mine.filter((row) => row.type === type);
      graded[type] = ofType.length;
      const leans = ofType.map(leanOf).filter((lean) => lean !== null);
      const max = maxByType[type] || 1;
      bias[type] = leans.length
        ? { points: round(mean(leans)), pct: round(mean(leans) / max, 4), docs: leans.length }
        : null;
    }
    const outliers = mine.filter((row) => row.isOutlier);
    return {
      ...grader,
      onTeam: memberIds.has(grader.id),
      graded,
      gradedTotal: mine.length,
      outlierCount: outliers.length,
      outliersHigh: outliers.filter((row) => row.deviation > 0).length,
      outliersByType: Object.fromEntries(DOCUMENT_TYPES.map((type) => [type, outliers.filter((row) => row.type === type).length])),
      splitCount: mine.filter((row) => row.split).length,
      overrides: mine.filter((row) => row.admin !== null).length,
      bias
    };
  }).sort((a, b) => Number(b.onTeam) - Number(a.onTeam) || b.outlierCount - a.outlierCount || a.name.localeCompare(b.name));
}

/**
 * The team's per-document mean against every other team in the cycle and
 * against the rest of the cycle pooled, as points and as a share of the max.
 * Rank 1 is the harshest team.
 */
export function teamComparison({ averages, teamOf, groupId, groups, maxByType }) {
  const result = {};
  for (const type of DOCUMENT_TYPES) {
    const max = maxByType[type] || 1;
    const ofType = averages.filter((entry) => entry.type === type && teamOf.get(entry.candidateId));
    const teams = groups.map((group) => {
      const values = ofType.filter((entry) => teamOf.get(entry.candidateId) === group.id).map((entry) => entry.avg);
      const teamMean = mean(values);
      return { groupId: group.id, name: group.name, mean: round(teamMean), pct: teamMean === null ? null : round(teamMean / max, 4), docs: values.length };
    });
    const team = teams.find((entry) => entry.groupId === groupId) || { mean: null, pct: null, docs: 0 };
    const rest = mean(ofType.filter((entry) => teamOf.get(entry.candidateId) !== groupId).map((entry) => entry.avg));
    const ranked = teams.filter((entry) => entry.mean !== null).sort((a, b) => a.mean - b.mean);
    const rankIndex = ranked.findIndex((entry) => entry.groupId === groupId);
    const delta = team.mean !== null && rest !== null ? team.mean - rest : null;

    result[type] = {
      max,
      team: { mean: team.mean, pct: team.pct, docs: team.docs },
      rest: { mean: round(rest), pct: rest === null ? null : round(rest / max, 4) },
      otherTeams: teams.filter((entry) => entry.groupId !== groupId),
      rank: rankIndex === -1 ? null : rankIndex + 1,
      of: ranked.length,
      delta: round(delta),
      deltaPct: delta === null ? null : round(delta / max, 4)
    };
  }
  return result;
}

/**
 * What the team still owes: grades members have not given, documents with one
 * grade, and missing decisions. A member is never owed a grade on their own
 * application (`candidate.excludedGraderIds`): the grading routes refuse it.
 */
export function completeness({ candidates, memberIds, rows }) {
  const missing = [];
  const singleGrader = [];
  for (const candidate of candidates) {
    const excluded = new Set(candidate.excludedGraderIds || []);
    for (const type of DOCUMENT_TYPES) {
      if (!candidate.hasDoc[type]) continue;
      const docRows = rows.filter((row) => row.candidateId === candidate.candidateId && row.type === type);
      const graded = new Set(docRows.map((row) => row.evaluatorId));
      const absent = memberIds.filter((id) => !graded.has(id) && !excluded.has(id));
      if (absent.length) missing.push({ applicationId: candidate.applicationId, type, memberIds: absent });
      if (docRows.length === 1) singleGrader.push({ applicationId: candidate.applicationId, type });
    }
  }
  const undecided = candidates.filter((candidate) => !candidate.resumeDecision).map((candidate) => candidate.applicationId);
  return {
    missing,
    missingCount: missing.reduce((sum, entry) => sum + entry.memberIds.length, 0),
    singleGrader,
    undecided
  };
}

/**
 * At most four one-line takeaways, biggest first. Each has a severity on one
 * scale (a share of the document max) so a team-wide lean and one grader's lean
 * can be ranked against each other.
 */
export function buildInsights({ comparison, graders, counts }) {
  const insights = [];

  for (const type of DOCUMENT_TYPES) {
    const entry = comparison[type];
    if (entry.deltaPct === null || Math.abs(entry.deltaPct) < TEAM_DELTA_MIN_PCT) continue;
    const direction = entry.delta < 0 ? 'harsher' : 'more generously';
    let text = `Grades ${PLURAL[type]} ${formatScore(Math.abs(entry.delta))} pts ${direction} than the rest of the cycle (${percent(entry.deltaPct)} of max)`;
    if (entry.of >= 3 && entry.rank === 1) text += `, the harshest of ${entry.of} teams`;
    else if (entry.of >= 3 && entry.rank === entry.of) text += `, the most generous of ${entry.of} teams`;
    insights.push({ id: `team-${type}`, severity: Math.abs(entry.deltaPct), text: `${text}.` });
  }

  const total = counts.outlierGrades;
  const top = graders.find((grader) => grader.onTeam && grader.outlierCount > 0);
  if (top && total >= 2 && top.outlierCount >= 2 && top.outlierCount / total >= 0.4) {
    const [mainType] = DOCUMENT_TYPES.slice().sort((a, b) => top.outliersByType[b] - top.outliersByType[a]);
    const lean = top.outliersHigh * 2 > top.outlierCount ? 'high' : top.outliersHigh * 2 < top.outlierCount ? 'low' : 'both ways';
    insights.push({
      id: `outliers-${top.id}`,
      severity: (top.outlierCount / total) * 0.3,
      text: `${top.name} had ${top.outlierCount} of ${total} outliers, mostly ${lean} on ${PLURAL[mainType]}.`
    });
  }

  for (const grader of graders.filter((entry) => entry.onTeam)) {
    for (const type of DOCUMENT_TYPES) {
      const bias = grader.bias[type];
      if (!bias || bias.docs < GRADER_BIAS_MIN_DOCS || Math.abs(bias.pct) < GRADER_BIAS_MIN_PCT) continue;
      insights.push({
        id: `bias-${grader.id}-${type}`,
        severity: Math.abs(bias.pct),
        text: `${grader.name} scores ${PLURAL[type]} ${formatScore(Math.abs(bias.points))} pts ${bias.points > 0 ? 'above' : 'below'} teammates on the same ${PLURAL[type]}.`
      });
    }
  }

  if (!insights.length && counts.scoredDocs > 0 && counts.outlierGrades === 0 && counts.splits === 0) {
    insights.push({ id: 'aligned', severity: 0, text: 'No outliers: this team graded in close agreement.' });
  }

  return insights.sort((a, b) => b.severity - a.severity).slice(0, MAX_INSIGHTS);
}

/** The "needs correcting" list. Each item names the candidates it is about, so the page can jump to them. */
export function buildFlags({ candidates, gaps }) {
  const flags = [];
  const withOutliers = candidates.filter((candidate) => candidate.outlierCount > 0);
  if (withOutliers.length) {
    const count = withOutliers.reduce((sum, candidate) => sum + candidate.outlierCount, 0);
    flags.push({
      id: 'outliers',
      level: 'error',
      text: `${count} outlier ${count === 1 ? 'grade' : 'grades'} on ${withOutliers.length} ${withOutliers.length === 1 ? 'candidate' : 'candidates'}`,
      applicationIds: withOutliers.map((candidate) => candidate.applicationId)
    });
  }
  const withSplits = candidates.filter((candidate) => candidate.splitDocs > 0);
  if (withSplits.length) {
    flags.push({
      id: 'splits',
      level: 'warning',
      text: `${withSplits.length} ${withSplits.length === 1 ? 'candidate' : 'candidates'} with a split between two graders`,
      applicationIds: withSplits.map((candidate) => candidate.applicationId)
    });
  }
  if (gaps.missingCount) {
    flags.push({
      id: 'missing',
      level: 'warning',
      text: `${gaps.missingCount} ${gaps.missingCount === 1 ? 'grade' : 'grades'} still missing from team members`,
      applicationIds: [...new Set(gaps.missing.map((entry) => entry.applicationId))]
    });
  }
  if (gaps.singleGrader.length) {
    flags.push({
      id: 'single',
      level: 'info',
      text: `${gaps.singleGrader.length} ${gaps.singleGrader.length === 1 ? 'document has' : 'documents have'} only one grade`,
      applicationIds: [...new Set(gaps.singleGrader.map((entry) => entry.applicationId))]
    });
  }
  if (gaps.undecided.length) {
    flags.push({
      id: 'undecided',
      level: 'info',
      text: `${gaps.undecided.length} ${gaps.undecided.length === 1 ? 'candidate has' : 'candidates have'} no Resume Review decision`,
      applicationIds: gaps.undecided
    });
  }
  return flags;
}

/**
 * Everything the overview and the candidate table need for one team.
 *
 * input:
 *   groupId, thresholdPct, maxByType
 *   participationMax: optional, the cap on participation points; only used to
 *                  report overallMax
 *   groups:     [{ id, name, members: [{ id, name }] }] - every team in the cycle
 *   candidates: [{ candidateId, applicationId, groupId, name, major, year,
 *                  hasDoc: { resume, coverLetter, video }, resumeDecision, locked,
 *                  participationPoints }] - participationPoints already capped,
 *                  0 when absent
 *   rows:       normalizeRow() output for the whole cycle, sealed candidates' already dropped
 *
 * A row's `overall` is Staging's: the documents total plus participation,
 * rounded to one place the way Staging rounds it, so both show the same number.
 */
export function computeTeamStats({ groupId, thresholdPct = DEFAULT_THRESHOLD_PCT, maxByType, participationMax = null, groups, candidates, rows }) {
  const group = groups.find((entry) => entry.id === groupId);
  const members = group?.members || [];
  const teamOf = new Map(candidates.map((candidate) => [candidate.candidateId, candidate.groupId]));

  const annotated = annotateOutliers(rows, { maxByType, thresholdPct });
  const team = candidates.filter((candidate) => candidate.groupId === groupId);
  const open = team.filter((candidate) => !candidate.locked);
  const openIds = new Set(open.map((candidate) => candidate.candidateId));
  const teamRows = annotated.filter((row) => openIds.has(row.candidateId));

  const averages = docAverages(annotated);
  const averageOf = new Map(averages.map((entry) => [docKey(entry.candidateId, entry.type), entry]));

  const table = team.map((candidate) => {
    // A sealed row is a name and nothing else, like redactApplication's.
    const identity = {
      applicationId: candidate.applicationId,
      candidateId: candidate.candidateId,
      name: candidate.name,
      locked: Boolean(candidate.locked)
    };
    if (candidate.locked) return identity;
    const base = { ...identity, major: candidate.major, year: candidate.year };

    const mine = teamRows.filter((row) => row.candidateId === candidate.candidateId);
    const perDoc = {};
    let total = 0;
    for (const type of DOCUMENT_TYPES) {
      const docRows = mine.filter((row) => row.type === type);
      const average = averageOf.get(docKey(candidate.candidateId, type));
      if (average) total += average.avg;
      perDoc[type] = {
        has: Boolean(candidate.hasDoc[type]),
        avg: round(average?.avg ?? null),
        n: docRows.length,
        outliers: docRows.filter((row) => row.isOutlier).length,
        split: docRows.some((row) => row.split),
        overridden: docRows.some((row) => row.admin !== null)
      };
    }
    const flagged = mine.filter((row) => row.flag);
    const participation = toNumber(candidate.participationPoints) ?? 0;
    return {
      ...base,
      perDoc,
      total: round(total),
      participation,
      overall: Number((total + participation).toFixed(1)),
      resumeDecision: candidate.resumeDecision ?? null,
      outlierCount: mine.filter((row) => row.isOutlier).length,
      splitDocs: DOCUMENT_TYPES.filter((type) => perDoc[type].split).length,
      // How far its widest disagreement is, as a share of that document's max.
      // Orders the walkthrough: the biggest disagreements are discussed first.
      spread: flagged.length ? Math.max(...flagged.map((row) => Math.abs(row.deviationPct))) : 0
    };
  });

  const openTable = table.filter((row) => !row.locked);
  const graders = graderSummaries(teamRows, members, maxByType);
  const comparison = teamComparison({ averages, teamOf, groupId, groups, maxByType });
  const gaps = completeness({ candidates: open, memberIds: members.map((member) => member.id), rows: teamRows });
  const counts = {
    candidates: team.length,
    sealed: team.length - open.length,
    scoredDocs: new Set(teamRows.map((row) => docKey(row.candidateId, row.type))).size,
    outlierGrades: teamRows.filter((row) => row.isOutlier).length,
    outlierCandidates: openTable.filter((row) => row.outlierCount > 0).length,
    splits: openTable.reduce((sum, row) => sum + row.splitDocs, 0),
    missing: gaps.missingCount,
    undecided: gaps.undecided.length,
    overrides: teamRows.filter((row) => row.admin !== null).length
  };

  const documentsMax = DOCUMENT_TYPES.reduce((sum, type) => sum + (maxByType[type] || 0), 0);
  return {
    thresholdPct,
    maxByType,
    participationMax,
    overallMax: participationMax === null ? null : documentsMax + participationMax,
    counts,
    graders,
    comparison,
    insights: buildInsights({ comparison, graders, counts }),
    flags: buildFlags({ candidates: openTable, gaps }),
    candidates: table,
    rows: teamRows
  };
}

/** The walkthrough: every candidate with an outlier or a split, widest disagreement first. */
export function outlierOrder(stats) {
  return stats.candidates
    .filter((row) => !row.locked && (row.outlierCount > 0 || row.splitDocs > 0))
    .sort((a, b) => b.spread - a.spread || a.name.localeCompare(b.name))
    .map((row) => row.applicationId);
}

/**
 * The walkthrough after the threshold changes. Entries already in it stay, in
 * their order, while they still have an outlier or split at the new threshold,
 * on effective scores or on the graded ones (`rawFlag`): a candidate whose
 * outlier an override resolved during the session is still one to come back
 * to. Then come candidates newly qualifying on effective scores, in
 * outlierOrder(). An entry sealed or moved off the team is not this function's
 * business and stays; the walk skips it when it gets there.
 */
export function rethresholdWalkthrough(stats, current = []) {
  const byApplication = new Map(stats.candidates.map((row) => [row.applicationId, row]));
  const rawFlagged = new Set(stats.rows.filter((row) => row.rawFlag).map((row) => row.candidateId));
  const kept = current.filter((applicationId) => {
    const row = byApplication.get(applicationId);
    if (!row || row.locked) return true;
    return row.outlierCount > 0 || row.splitDocs > 0 || rawFlagged.has(row.candidateId);
  });
  const keptIds = new Set(kept);
  return [...kept, ...outlierOrder(stats).filter((applicationId) => !keptIds.has(applicationId))];
}

/**
 * Where the walkthrough stands once its list changed: the same candidate if they
 * are still in it, otherwise the next one after them that is, otherwise the last.
 */
export function walkthroughPosition(before, after, applicationId) {
  if (!applicationId || after.includes(applicationId)) return applicationId ?? null;
  const later = before.slice(before.indexOf(applicationId) + 1).find((id) => after.includes(id));
  return later ?? after.at(-1) ?? null;
}

export const docLabel = (type) => SINGULAR[type] || type;
