// One application per candidate per cycle.
//
// A cycle's form can be replaced mid-cycle (previousFormUrls), and people
// submit twice: once to the old form and again to the new one, or the same
// form twice because the first attempt went wrong. Sync used to dedupe only by
// Google's response id, so every one of those became a second Application row.
// Staging then showed the person twice, and because decisions, comments,
// evaluations and interview signups hang off the application id, the review of
// one person ended up split across two rows.
//
// This file owns what happens when one candidate has more than one submission
// in a cycle. Form sync asks it before filing a response for someone who
// already applied, and the one-time cleanup script asks it to fold the rows
// that already exist. Neither caller decides anything itself.
//
// The rule is short. A later submission replaces the answers only while nobody
// has started reviewing the application, because reviewers must never find the
// resume they scored swapped underneath them. In every other case the response
// is only remembered in `supersededResponseIds`, so sync never files it again,
// and the application keeps the answers it had.

export const RESUBMISSION_ACTIONS = Object.freeze({
  REPLACE: 'REPLACE',
  RECORD_ONLY: 'RECORD_ONLY'
});

export const RESUBMISSION_REASONS = Object.freeze({
  NEWER_SUBMISSION: 'NEWER_SUBMISSION',
  OLDER_SUBMISSION: 'OLDER_SUBMISSION',
  REVIEW_STARTED: 'REVIEW_STARTED',
  RECORD_LOCKED: 'RECORD_LOCKED',
  // The response is already this row's own or already remembered by it.
  ALREADY_RECORDED: 'ALREADY_RECORDED',
  // The row changed between the read and the write (another server's sync, or
  // a reviewer's decision landing in that instant), so nothing was replaced.
  CHANGED_DURING_SYNC: 'CHANGED_DURING_SYNC'
});

// Every Application column that comes from the form, which is everything
// transformFormResponse produces: the three it always sets (responseID,
// submittedAt, rawResponses) and every `field` in form-config.json, including
// ones only older versions of the form used (coverLetterUrl).
//
// blindResumeUrl is here because it is a form answer, not something derived
// later: the form asks for the anonymized resume as its own upload (question
// 366cc943). Nothing in the server generates one from resumeUrl. The only
// other writer is the candidate resume replacement route, which clears it,
// because a blind copy of the resume being replaced no longer matches.
export const SUBMISSION_FIELDS = Object.freeze([
  'responseID',
  'submittedAt',
  'rawResponses',
  'email',
  'firstName',
  'lastName',
  'studentId',
  'phoneNumber',
  'graduationYear',
  'isTransferStudent',
  'priorCollegeYears',
  'cumulativeGpa',
  'majorGpa',
  'major1',
  'major2',
  'gender',
  'isFirstGeneration',
  'talentPoolOptIn',
  'resumeUrl',
  'blindResumeUrl',
  'headshotUrl',
  'coverLetterUrl',
  'shortAnswer',
  'videoUrl'
]);

// Submission columns the schema lets be null. A resubmission that leaves one of
// these out clears it: a new form without the blind-resume question must not
// leave the old resume's blind copy on the row, where a BLIND Talent Partner
// client would be shown it. The other submission columns are NOT NULL, so a
// resubmission missing one keeps the earlier answer rather than failing.
const NULLABLE_SUBMISSION_FIELDS = new Set([
  'priorCollegeYears',
  'majorGpa',
  'major2',
  'gender',
  'talentPoolOptIn',
  'blindResumeUrl',
  'coverLetterUrl',
  'shortAnswer',
  'videoUrl'
]);

export const DECISION_FIELDS = Object.freeze([
  'resumeDecision',
  'coffeeChatDecision',
  'firstRoundDecision',
  'finalRoundDecision'
]);

// What a reviewer writes. Never touched by a resubmission; merged with care by
// the cleanup.
export const REVIEW_FIELDS = Object.freeze(['status', 'currentRound', 'approved', ...DECISION_FIELDS]);

const isBlank = (value) => value === null || value === undefined || value === '';

// The value each review field holds before anyone has reviewed anything. Sync
// creates applications in round '1', older rows can have no round at all.
const isUntouched = (field, value) => {
  if (isBlank(value)) return true;
  if (field === 'status') return value === 'SUBMITTED';
  if (field === 'currentRound') return value === '1';
  return false;
};

/** Whether anyone has started reviewing this application. */
export const reviewStarted = (application) =>
  REVIEW_FIELDS.some((field) => !isUntouched(field, application?.[field]));

const timeOf = (value) => {
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

/**
 * What to do with `incoming`, a submission from a candidate who already has
 * `existing` in the same cycle. Pure.
 *
 * REPLACE only when the incoming submission is strictly later and nothing about
 * the existing one has been reviewed or sealed. Otherwise RECORD_ONLY: the
 * response id is remembered so it is never synced again, and the answers stay.
 * An unreadable submit time counts as not later, which is the side that changes
 * nothing.
 */
export function resubmissionPlan({ existing, incoming, candidateLocked = false }) {
  const existingAt = timeOf(existing?.submittedAt);
  const incomingAt = timeOf(incoming?.submittedAt);
  if (incomingAt === null || existingAt === null || incomingAt <= existingAt) {
    return { action: RESUBMISSION_ACTIONS.RECORD_ONLY, reason: RESUBMISSION_REASONS.OLDER_SUBMISSION };
  }
  if (candidateLocked) {
    return { action: RESUBMISSION_ACTIONS.RECORD_ONLY, reason: RESUBMISSION_REASONS.RECORD_LOCKED };
  }
  if (reviewStarted(existing)) {
    return { action: RESUBMISSION_ACTIONS.RECORD_ONLY, reason: RESUBMISSION_REASONS.REVIEW_STARTED };
  }
  return { action: RESUBMISSION_ACTIONS.REPLACE, reason: RESUBMISSION_REASONS.NEWER_SUBMISSION };
}

/**
 * The update that makes `existing` hold `incoming`'s answers: every submission
 * field replaced, and the response being replaced appended to
 * `supersededResponseIds`. Review fields, ids, the cycle, the candidate and
 * testFor are never in it.
 */
export function replacementData(existing, incoming) {
  const data = {};
  for (const field of SUBMISSION_FIELDS) {
    const value = incoming?.[field];
    if (value === undefined || value === null) {
      if (NULLABLE_SUBMISSION_FIELDS.has(field)) data[field] = null;
      continue;
    }
    data[field] = value;
  }
  data.supersededResponseIds = appendIds(existing?.supersededResponseIds, [existing?.responseID], data.responseID);
  return data;
}

/** `current` plus `ids`, each once, in order, never including `exclude`. */
export function appendIds(current = [], ids = [], exclude = null) {
  const out = [];
  for (const id of [...(current || []), ...ids]) {
    if (isBlank(id) || id === exclude || out.includes(id)) continue;
    out.push(id);
  }
  return out;
}

// The same "nobody has reviewed it" test as reviewStarted, as a where clause,
// so a decision written in the instant between sync's read and its write
// stops the replacement instead of being overwritten by it.
const UNTOUCHED_WHERE = [
  { status: 'SUBMITTED' },
  { approved: null },
  { OR: [{ currentRound: null }, { currentRound: '1' }] },
  ...DECISION_FIELDS.map((field) => ({ OR: [{ [field]: null }, { [field]: '' }] }))
];

async function recordOnly(client, applicationId, responseID) {
  // Conditional, so two servers recording the same response at once still
  // leave it in the list once, and a response that is the row's own is never
  // listed as superseded by itself.
  await client.application.updateMany({
    where: {
      id: applicationId,
      NOT: [{ responseID }, { supersededResponseIds: { has: responseID } }]
    },
    data: { supersededResponseIds: { push: responseID } }
  });
}

/**
 * Applies resubmissionPlan to `existing` through `client` (the Prisma client or
 * a transaction). `incoming` is the record transformFormResponse produced.
 * Returns { action, reason, applicationId }.
 */
export async function applyResubmission(client, { existing, incoming, candidateLocked = false }) {
  const applicationId = existing.id;
  const responseID = incoming.responseID;

  if (responseID === existing.responseID || (existing.supersededResponseIds || []).includes(responseID)) {
    return { action: RESUBMISSION_ACTIONS.RECORD_ONLY, reason: RESUBMISSION_REASONS.ALREADY_RECORDED, applicationId };
  }

  const plan = resubmissionPlan({ existing, incoming, candidateLocked });
  if (plan.action === RESUBMISSION_ACTIONS.RECORD_ONLY) {
    await recordOnly(client, applicationId, responseID);
    return { ...plan, applicationId };
  }

  const data = replacementData(existing, incoming);
  const { count } = await client.application.updateMany({
    where: { id: applicationId, responseID: existing.responseID, AND: UNTOUCHED_WHERE },
    data
  });
  if (count === 0) {
    await recordOnly(client, applicationId, responseID);
    return { action: RESUBMISSION_ACTIONS.RECORD_ONLY, reason: RESUBMISSION_REASONS.CHANGED_DURING_SYNC, applicationId };
  }

  // A candidate who replaced their resume in the portal has version rows, and
  // exactly one of them is meant to be current. The form's new resume is now
  // the current one, so the old current row is closed and the new file gets a
  // row of its own, the same shape the portal writes for a Drive original.
  if (data.resumeUrl && data.resumeUrl !== existing.resumeUrl) {
    const versions = await client.resumeUpload.count({ where: { applicationId } });
    if (versions > 0) {
      const now = new Date();
      await client.resumeUpload.updateMany({
        where: { applicationId, supersededAt: null },
        data: { supersededAt: now }
      });
      await client.resumeUpload.create({
        data: {
          applicationId,
          storagePath: null,
          sourceUrl: data.resumeUrl,
          uploadedAt: data.submittedAt instanceof Date ? data.submittedAt : new Date(data.submittedAt)
        }
      });
    }
  }

  return { ...plan, applicationId };
}

// ---------------------------------------------------------------------------
// The one-time cleanup of duplicates that already exist.
// ---------------------------------------------------------------------------

/**
 * Every table holding an application id. Merging re-points each of these from
 * the rows being folded away to the one that survives, before deleting them;
 * a table missing from here would be orphaned (no foreign key) or have its
 * rows cascade-deleted or block the delete (with one).
 *
 * `uniques` are the unique constraints that include the application column,
 * listed by their other columns and, for a partial index, its predicate. Two
 * rows of the same person that agree on one of these cannot both move onto the
 * survivor, so the merge refuses instead of picking one.
 *
 * Kept in step with schema.prisma by applicationResubmissions.schema.test.js,
 * and with the live database by the merge script's --apply preflight.
 */
export const APPLICATION_DEPENDENTS = Object.freeze([
  { table: 'comments', model: 'comment', column: 'applicationId', uniques: [] },
  { table: 'flagged_documents', model: 'flaggedDocument', column: 'applicationId', uniques: [] },
  {
    table: 'interview_evaluations', model: 'interviewEvaluation', column: 'applicationId',
    uniques: [{ columns: ['interviewId', 'evaluatorId'] }]
  },
  {
    table: 'first_round_interview_evaluations', model: 'firstRoundInterviewEvaluation', column: 'applicationId',
    uniques: [{ columns: ['interviewId', 'evaluatorId'] }]
  },
  {
    table: 'case_assignments', model: 'caseAssignment', column: 'applicationId',
    uniques: [{ columns: ['interviewId'] }]
  },
  { table: 'resume_uploads', model: 'resumeUpload', column: 'applicationId', uniques: [] },
  {
    table: 'client_resume_assignments', model: 'clientResumeAssignment', column: 'applicationId',
    uniques: [{ columns: ['clientId'], where: { revokedAt: null } }]
  },
  { table: 'behavioral_questions', model: 'behavioralQuestion', column: 'applicationId', uniques: [] },
  {
    table: 'interview_slot_signups', model: 'interviewSlotSignup', column: 'applicationId',
    uniques: [
      { columns: ['interviewId'], where: { status: 'CONFIRMED' } },
      { columns: ['interviewId'], where: { status: 'WAITLISTED' } }
    ]
  },
  {
    table: 'live_vote_session_candidates', model: 'liveVoteSessionCandidate', column: 'applicationId',
    uniques: [{ columns: ['sessionId'] }]
  },
  {
    table: 'decision_messages', model: 'decisionMessage', column: 'applicationId',
    uniques: [{ columns: ['fromRound', 'outcome'] }]
  },
  // No foreign key: a deleted application would leave these pointing at nothing.
  { table: 'review_delib_changes', model: 'reviewDelibChange', column: 'applicationId', uniques: [] },
  // The candidate on screen in a review deliberation. Its sibling,
  // outlierApplicationIds, is a JSON array and is rewritten separately.
  { table: 'review_delib_sessions', model: 'reviewDelibSession', column: 'currentApplicationId', uniques: [] }
]);

/**
 * Application ids held inside a JSON array rather than a column of their own.
 * The merge rewrites these by hand; they are listed so the schema test and the
 * script's preflight know they are accounted for.
 */
export const APPLICATION_ID_ARRAYS = Object.freeze([
  { table: 'review_delib_sessions', model: 'reviewDelibSession', column: 'outlierApplicationIds' }
]);

export const MERGE_CONFLICTS = Object.freeze({
  REVIEW_CONFLICT: 'REVIEW_CONFLICT',
  UNIQUE_COLLISION: 'UNIQUE_COLLISION',
  RESUME_VERSIONS: 'RESUME_VERSIONS',
  RECORD_LOCKED: 'RECORD_LOCKED',
  NOT_A_GROUP: 'NOT_A_GROUP'
});

/**
 * Raised when a group cannot be merged without choosing between two things a
 * person wrote. The caller skips the whole group and reports it; nothing in
 * the group has been changed, because the merge runs inside the caller's
 * transaction and a throw rolls it back.
 */
export class ApplicationMergeConflict extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ApplicationMergeConflict';
    this.code = code;
    this.details = details;
  }
}

const SUMMARY_FIELDS = ['id', 'candidateId', 'cycleId', ...SUBMISSION_FIELDS, ...REVIEW_FIELDS];

// What the dry run reads. Deliberately an explicit list without
// supersededResponseIds: the dry run is meant to be run against production
// before that column exists.
const REPORT_SELECT = Object.freeze(Object.fromEntries(
  ['id', 'candidateId', 'cycleId', 'responseID', 'submittedAt', 'email', 'firstName', 'lastName',
    'resumeUrl', ...REVIEW_FIELDS].map((field) => [field, true])
));

const byOldest = (a, b) => (timeOf(a.submittedAt) ?? 0) - (timeOf(b.submittedAt) ?? 0)
  || String(a.id).localeCompare(String(b.id));

/**
 * The review fields of a group folded into one, or the fields on which two rows
 * disagree. Untouched values (no decision, round '1', SUBMITTED) are empty, so
 * a round advanced on one row and untouched on the other is simply advanced.
 * Pure.
 */
export function mergeReviewFields(applications, survivorId) {
  const survivor = applications.find((app) => app.id === survivorId) ?? applications[0];
  const review = {};
  const conflicts = [];
  for (const field of REVIEW_FIELDS) {
    const set = applications.filter((app) => !isUntouched(field, app[field]));
    const distinct = [...new Set(set.map((app) => String(app[field])))];
    if (distinct.length > 1) {
      conflicts.push({ field, values: set.map((app) => ({ applicationId: app.id, value: app[field] })) });
      continue;
    }
    review[field] = set.length
      ? { value: set[0][field], from: set[0].id }
      : { value: survivor[field] ?? null, from: null };
  }
  return { review, conflicts };
}

/**
 * How a group would merge, without touching anything. Pure, and shared by the
 * dry run and the merge itself so the two cannot disagree.
 *
 * The survivor is the oldest row, since it is the one longest referenced from
 * elsewhere. Its answers come from the latest submission: people resubmitted
 * because the first form was broken, so the latest is what they meant to send.
 */
export function planDuplicateMerge({ applications, survivorId = null, candidateLocked = false, resumeVersionCounts = {}, collisions = [] }) {
  const ordered = [...applications].sort(byOldest);
  const survivor = ordered.find((app) => app.id === survivorId) ?? ordered[0];
  const losers = ordered.filter((app) => app.id !== survivor.id);
  const content = ordered[ordered.length - 1];
  const { review, conflicts: reviewConflicts } = mergeReviewFields(ordered, survivor.id);

  const conflicts = [];
  if (candidateLocked) {
    conflicts.push({ code: MERGE_CONFLICTS.RECORD_LOCKED, message: 'the candidate record is sealed' });
  }
  for (const conflict of reviewConflicts) {
    conflicts.push({
      code: MERGE_CONFLICTS.REVIEW_CONFLICT,
      message: `${conflict.field} differs: ${conflict.values.map((v) => `${v.value} on ${v.applicationId}`).join(', ')}`,
      ...conflict
    });
  }

  // Portal resume replacements keep a version history that has to name the
  // file resumeUrl points at. Only one row may carry that history, and it has
  // to be the row whose answers are kept, or the merged row would show one
  // resume while its history says another is current.
  const withVersions = ordered.filter((app) => (resumeVersionCounts[app.id] || 0) > 0);
  if (withVersions.length > 1 || (withVersions.length === 1 && withVersions[0].id !== content.id)) {
    conflicts.push({
      code: MERGE_CONFLICTS.RESUME_VERSIONS,
      message: `resume replaced in the portal on ${withVersions.map((app) => app.id).join(', ')}, `
        + `but the answers kept are ${content.id}'s`
    });
  }

  for (const collision of collisions) {
    conflicts.push({
      code: MERGE_CONFLICTS.UNIQUE_COLLISION,
      message: `${collision.table} has rows on ${collision.applicationIds.join(', ')} that share ${collision.key}`,
      ...collision
    });
  }

  return { survivorId: survivor.id, loserIds: losers.map((app) => app.id), contentFrom: content.id, review, conflicts };
}

/**
 * Dependent rows that could not all move onto one application, because a
 * unique constraint would see them as the same row. Read-only.
 */
export async function findUniqueCollisions(client, applicationIds) {
  const collisions = [];
  for (const dependent of APPLICATION_DEPENDENTS) {
    for (const unique of dependent.uniques) {
      const rows = await client[dependent.model].findMany({
        where: { [dependent.column]: { in: applicationIds }, ...(unique.where || {}) },
        select: Object.fromEntries([dependent.column, ...unique.columns].map((c) => [c, true]))
      });
      const owners = new Map();
      for (const row of rows) {
        const key = unique.columns.map((c) => `${c}=${row[c]}`).join(', ');
        const set = owners.get(key) ?? new Set();
        set.add(row[dependent.column]);
        owners.set(key, set);
      }
      for (const [key, set] of owners) {
        if (set.size > 1) {
          const where = unique.where ? ` (${Object.entries(unique.where).map(([k, v]) => `${k}=${v}`).join(', ')})` : '';
          collisions.push({ table: dependent.table, key: key + where, applicationIds: [...set] });
        }
      }
    }
  }
  return collisions;
}

/** { [table]: { [applicationId]: count } } for the given applications. Read-only. */
export async function countDependents(client, applicationIds) {
  const counts = {};
  for (const dependent of APPLICATION_DEPENDENTS) {
    const rows = await client[dependent.model].groupBy({
      by: [dependent.column],
      where: { [dependent.column]: { in: applicationIds } },
      _count: { _all: true }
    });
    counts[dependent.table] = Object.fromEntries(rows.map((row) => [row[dependent.column], row._count._all]));
  }
  return counts;
}

const isUniqueViolation = (error) => error?.code === 'P2002'
  || /unique constraint/i.test(String(error?.message || ''));

/**
 * Folds `loserIds` into `survivorId` inside `tx`, the caller's transaction.
 *
 * Re-points every APPLICATION_DEPENDENTS row, rewrites review deliberation
 * walkthrough orders, deletes the losers, then gives the survivor the latest
 * submission's answers, the merged review fields, and every response id the
 * group had seen. Throws ApplicationMergeConflict, having changed nothing the
 * transaction will keep, when the group cannot be merged without choosing
 * between two people's work.
 */
export async function mergeDuplicateApplications(tx, { survivorId, loserIds }) {
  const ids = [survivorId, ...loserIds];
  const applications = await tx.application.findMany({
    where: { id: { in: ids } },
    select: {
      ...Object.fromEntries(SUMMARY_FIELDS.map((field) => [field, true])),
      supersededResponseIds: true,
      candidate: { select: { recordsLockedAt: true } }
    }
  });

  const candidateIds = new Set(applications.map((app) => app.candidateId));
  const cycleIds = new Set(applications.map((app) => app.cycleId));
  if (applications.length !== ids.length || candidateIds.size !== 1 || cycleIds.size !== 1 || !applications[0].candidateId) {
    throw new ApplicationMergeConflict(
      MERGE_CONFLICTS.NOT_A_GROUP,
      'these applications are not one candidate in one cycle',
      { survivorId, loserIds }
    );
  }

  const resumeVersions = await tx.resumeUpload.groupBy({
    by: ['applicationId'],
    where: { applicationId: { in: ids } },
    _count: { _all: true }
  });
  const plan = planDuplicateMerge({
    applications,
    survivorId,
    candidateLocked: applications.some((app) => app.candidate?.recordsLockedAt),
    resumeVersionCounts: Object.fromEntries(resumeVersions.map((row) => [row.applicationId, row._count._all])),
    collisions: await findUniqueCollisions(tx, ids)
  });
  if (plan.conflicts.length) {
    throw new ApplicationMergeConflict(plan.conflicts[0].code, plan.conflicts.map((c) => c.message).join('; '), {
      conflicts: plan.conflicts
    });
  }

  const moved = {};
  for (const dependent of APPLICATION_DEPENDENTS) {
    try {
      const { count } = await tx[dependent.model].updateMany({
        where: { [dependent.column]: { in: loserIds } },
        data: { [dependent.column]: survivorId }
      });
      moved[dependent.table] = count;
    } catch (error) {
      // The pre-check above reads the constraints this file knows about. One
      // added since still lands here, as the same skip, never a half merge.
      if (isUniqueViolation(error)) {
        throw new ApplicationMergeConflict(
          MERGE_CONFLICTS.UNIQUE_COLLISION,
          `${dependent.table}: ${error.message}`,
          { table: dependent.table }
        );
      }
      throw error;
    }
  }

  // The walkthrough order of a review deliberation is stored as a JSON array of
  // application ids, which no updateMany can reach.
  const sessions = await tx.reviewDelibSession.findMany({
    where: { cycleId: applications[0].cycleId },
    select: { id: true, outlierApplicationIds: true }
  });
  let rewrittenOrders = 0;
  for (const session of sessions) {
    const order = Array.isArray(session.outlierApplicationIds) ? session.outlierApplicationIds : [];
    if (!order.some((id) => loserIds.includes(id))) continue;
    const next = [];
    for (const id of order.map((id) => (loserIds.includes(id) ? survivorId : id))) {
      if (!next.includes(id)) next.push(id);
    }
    await tx.reviewDelibSession.update({ where: { id: session.id }, data: { outlierApplicationIds: next } });
    rewrittenOrders += 1;
  }
  moved['review_delib_sessions.outlierApplicationIds'] = rewrittenOrders;

  const byId = new Map(applications.map((app) => [app.id, app]));
  const survivor = byId.get(survivorId);
  const content = byId.get(plan.contentFrom);
  const ordered = [...applications].sort(byOldest);

  // Losers first: responseID is unique, and the survivor may be about to take
  // a loser's.
  await tx.application.deleteMany({ where: { id: { in: loserIds } } });

  const data = {};
  for (const field of SUBMISSION_FIELDS) data[field] = content[field];
  for (const field of REVIEW_FIELDS) data[field] = plan.review[field].value;
  data.supersededResponseIds = appendIds(
    [],
    ordered.flatMap((app) => [...(app.supersededResponseIds || []), app.responseID]),
    content.responseID
  );
  await tx.application.update({ where: { id: survivorId }, data });

  return {
    survivorId,
    loserIds,
    contentFrom: plan.contentFrom,
    responseID: content.responseID,
    review: plan.review,
    moved,
    supersededResponseIds: data.supersededResponseIds,
    previousResponseID: survivor.responseID
  };
}

/**
 * Every candidate with more than one application in `cycleId`, oldest first,
 * with what a report needs and the dependent rows on each application. Read-only.
 *
 * Uses only explicit selects that leave out supersededResponseIds, so it runs
 * against a database that has not had that migration yet.
 */
export async function findDuplicateApplicationGroups(client, { cycleId }) {
  const all = await client.application.findMany({
    where: { cycleId, candidateId: { not: null } },
    select: { id: true, candidateId: true }
  });
  const perCandidate = new Map();
  for (const app of all) perCandidate.set(app.candidateId, (perCandidate.get(app.candidateId) || 0) + 1);
  const duplicated = [...perCandidate].filter(([, n]) => n > 1).map(([candidateId]) => candidateId);
  if (!duplicated.length) return [];

  const applications = await client.application.findMany({
    where: { cycleId, candidateId: { in: duplicated } },
    select: {
      ...REPORT_SELECT,
      candidate: { select: { id: true, firstName: true, lastName: true, email: true, recordsLockedAt: true } }
    },
    orderBy: [{ submittedAt: 'asc' }, { id: 'asc' }]
  });

  const groups = new Map();
  for (const app of applications) {
    const group = groups.get(app.candidateId) ?? { candidateId: app.candidateId, candidate: app.candidate, applications: [] };
    const { candidate, ...row } = app;
    group.applications.push(row);
    groups.set(app.candidateId, group);
  }

  // Walkthrough orders are JSON, so countDependents cannot see them; counted
  // here so the report shows every place an application id is held.
  const sessions = await client.reviewDelibSession.findMany({
    where: { cycleId },
    select: { outlierApplicationIds: true }
  });

  const result = [];
  for (const group of groups.values()) {
    group.applications.sort(byOldest);
    const ids = group.applications.map((app) => app.id);
    const dependents = await countDependents(client, ids);
    dependents['review_delib_sessions.outlierApplicationIds'] = Object.fromEntries(ids
      .map((id) => [id, sessions.filter((s) => Array.isArray(s.outlierApplicationIds) && s.outlierApplicationIds.includes(id)).length])
      .filter(([, n]) => n > 0));
    const collisions = await findUniqueCollisions(client, ids);
    const plan = planDuplicateMerge({
      applications: group.applications,
      candidateLocked: Boolean(group.candidate?.recordsLockedAt),
      resumeVersionCounts: dependents.resume_uploads || {},
      collisions
    });
    result.push({ ...group, dependents, plan });
  }
  return result;
}
