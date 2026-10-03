import prisma from '../../prismaClient.js';
import { resolveAdminCycle } from '../activeCycle.js';
import { getCycleEventParticipation, getCycleReferrals } from '../applicationParticipation.js';
import { adminScorePatch, DOCUMENT_TYPES, formatScore } from '../documentRubrics.js';
import { isDecisionValue, saveRoundDecision } from '../stagingDecisions.js';
import { nudgeReviewDelib, nudgeReviewDelibsGlobal } from '../realtime.js';
import { withVersionLock } from '../versionLock.js';
import { isOwnedBy } from '../../utils/applicationOwnership.js';
import { getGroupMemberIds, getGroupMemberUsers, groupMemberUserInclude } from '../../utils/groupMembers.js';
import { sealedApplicationIds } from '../../utils/lockedRecords.js';
import { loadTeamInput, groupName, scoreModel } from './teamData.js';
import {
  computeTeamStats,
  DEFAULT_THRESHOLD_PCT,
  docLabel,
  MAX_THRESHOLD_PCT,
  MIN_THRESHOLD_PCT,
  outlierOrder,
  rethresholdWalkthrough
} from './teamStats.js';

// Review team deliberations.
//
// After document grading, admins meet each review team for ten minutes to go
// over what the team graded. An admin launches a session for one team; the
// team's members and any admin join. Each of them moves around it on their own:
// the overview, the candidates with an outlier or split, the whole list and the
// summary. What is shared is the data: the threshold, overrides and decisions
// are admin actions, and everyone sees their result. Any admin who has joined
// can run it, so the session survives its creator losing wifi.
//
// Edits made in the room are ordinary edits: an override is the score row's
// adminScore, written through adminScorePatch like Application Detail's edit,
// and a decision is saveRoundDecision, the write behind Staging's picker. So
// Staging shows them at once and decision processing reads them unchanged.
//
// Who may watch: admins, and the team's current members - checked on every
// request, so someone moved off the team mid-session loses access. Nobody else,
// not even other members. Sealed candidates are identity only, and the
// executive unlock is ignored: one admin's unlock says nothing about who else is
// looking at the screen.
//
// Concurrency is the live vote's: every change runs in withVersionLock on the
// session row, then sends a content-free nudge; clients refetch on a new version.

const PRESENCE_WINDOW_MS = 30_000;
const HEARTBEAT_EVERY_MS = 5_000;
const STATE_CACHE_TTL_MS = 1_000;
// Grades saved outside the session (a member finishing a late grade) do not
// bump its version, so the team view is also refreshed on age.
const TEAM_CACHE_TTL_MS = 5_000;

const fail = (status, message, code, extra = {}) =>
  Object.assign(new Error(message), { status, code, ...extra });

const OWNERSHIP_SELECT = {
  id: true,
  email: true,
  studentId: true,
  candidateId: true,
  firstName: true,
  lastName: true,
  resumeDecision: true,
  candidate: { select: { email: true, studentId: true } }
};

const lock = (client, sessionId, fn) =>
  withVersionLock(client, 'reviewDelibSession', sessionId, fn, { notFoundMessage: 'Deliberation not found' });

const isAdmin = (user) => user?.role === 'ADMIN';

function canWatch(group, user) {
  if (!user || user.isExternalTalent) return false;
  if (isAdmin(user)) return true;
  return user.role === 'MEMBER' && getGroupMemberIds(group).includes(user.id);
}

async function loadHead(client, sessionId) {
  const session = await client.reviewDelibSession.findUnique({
    where: { id: sessionId },
    include: { group: { include: groupMemberUserInclude } }
  });
  if (!session) throw fail(404, 'Deliberation not found', 'NOT_FOUND');
  return session;
}

async function loadForViewer(client, sessionId, user) {
  const session = await loadHead(client, sessionId);
  if (!canWatch(session.group, user)) {
    throw fail(403, `This deliberation is for ${groupName(session.group)}`, 'NOT_ON_TEAM', { groupName: groupName(session.group) });
  }
  return session;
}

const assertActive = (session) => {
  if (session.status !== 'ACTIVE') throw fail(409, 'This deliberation has ended', 'SESSION_ENDED');
};

async function assertHost(tx, session, user) {
  if (!isAdmin(user)) throw fail(403, 'Only admins can run a deliberation', 'FORBIDDEN');
  const participant = await tx.reviewDelibParticipant.findUnique({
    where: { sessionId_userId: { sessionId: session.id, userId: user.id } },
    select: { leftAt: true }
  });
  if (!participant || participant.leftAt) throw fail(403, 'Join the deliberation to run it', 'JOIN_REQUIRED');
}

/** The team's application for `applicationId`, or a 404. Refuses sealed (423) and, for writes, the admin's own (403). */
async function teamApplication(tx, session, where, user, { forWrite = false } = {}) {
  const application = await tx.application.findFirst({
    where: { ...where, cycleId: session.cycleId, candidate: { assignedGroupId: session.groupId } },
    orderBy: { submittedAt: 'desc' },
    select: OWNERSHIP_SELECT
  });
  if (!application) throw fail(404, "That candidate is not on this team's list", 'NOT_ON_TEAM_LIST');
  if ((await sealedApplicationIds([application.id], tx)).has(application.id)) {
    throw fail(423, 'This record is sealed', 'RECORD_LOCKED');
  }
  if (forWrite && isOwnedBy(application, user)) {
    throw fail(403, 'You cannot change your own record', 'OWN_RECORD');
  }
  return application;
}

function normalizeThreshold(value) {
  if (value === undefined || value === null || value === '') return DEFAULT_THRESHOLD_PCT;
  const number = Number(value);
  if (!Number.isFinite(number) || number < MIN_THRESHOLD_PCT - 1e-9 || number > MAX_THRESHOLD_PCT + 1e-9) {
    throw fail(400, `The outlier threshold must be between ${MIN_THRESHOLD_PCT * 100}% and ${MAX_THRESHOLD_PCT * 100}% of the max`, 'INVALID_THRESHOLD');
  }
  return Math.round(number * 100) / 100;
}

// ---------------------------------------------------------------------------
// The team's numbers, shared between everyone polling one session
// ---------------------------------------------------------------------------

const teamCache = new Map();
const stateCache = new Map();

export function clearCaches() {
  teamCache.clear();
  stateCache.clear();
}

/**
 * Who is on the team's list right now and which of them are sealed, as a
 * string. Sealing a record or moving a candidate bumps no session version, so
 * the team cache is also keyed on this, read fresh every time: a seal or a move
 * is never served from a bundle built before it.
 */
async function teamFingerprint(client, session) {
  const applications = await client.application.findMany({
    where: { cycleId: session.cycleId, candidate: { assignedGroupId: session.groupId } },
    select: { id: true }
  });
  const ids = applications.map((row) => row.id).sort();
  const sealed = await sealedApplicationIds(ids, client);
  return ids.map((id) => (sealed.has(id) ? `${id}*` : id)).join(',');
}

async function teamBundle(client, session, now = Date.now()) {
  const key = `${session.version}:${session.thresholdPct}:${await teamFingerprint(client, session)}`;
  const cached = teamCache.get(session.id);
  if (cached && cached.key === key && now - cached.at <= TEAM_CACHE_TTL_MS) return cached.bundle;

  const input = await loadTeamInput({ client, groupId: session.groupId, cycleId: session.cycleId });
  const stats = computeTeamStats({ ...input, thresholdPct: session.thresholdPct });
  const bundle = { input, stats };
  teamCache.set(session.id, { key, at: now, bundle });
  return bundle;
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function launchSession({ client = prisma, user, groupId, thresholdPct }) {
  if (!isAdmin(user)) throw fail(403, 'Only admins can start a deliberation', 'FORBIDDEN');
  if (typeof groupId !== 'string' || !groupId) throw fail(400, 'Choose a review team', 'INVALID_GROUP');
  const threshold = normalizeThreshold(thresholdPct);

  const cycle = await resolveAdminCycle(client);
  if (!cycle) throw fail(400, 'No active recruiting cycle', 'NO_CYCLE');
  const group = await client.groups.findUnique({ where: { id: groupId }, select: { id: true, cycleId: true, name: true } });
  if (!group) throw fail(404, 'Review team not found', 'NOT_FOUND');
  if (group.cycleId !== cycle.id) {
    throw fail(409, 'That review team belongs to another cycle', 'GROUP_NOT_IN_CYCLE');
  }

  const input = await loadTeamInput({ client, groupId, cycleId: cycle.id, participation: false });
  const order = outlierOrder(computeTeamStats({ ...input, thresholdPct: threshold }));

  let session;
  try {
    session = await client.reviewDelibSession.create({
      data: {
        groupId,
        cycleId: cycle.id,
        thresholdPct: threshold,
        outlierApplicationIds: order,
        createdById: user.id,
        participants: { create: { userId: user.id } }
      },
      select: { id: true, status: true }
    });
  } catch (error) {
    if (error?.code === 'P2002') {
      const open = await client.reviewDelibSession.findFirst({
        where: { groupId, status: 'ACTIVE' },
        select: { id: true }
      });
      throw fail(409, 'This team already has a deliberation running', 'DELIB_ACTIVE', { sessionId: open?.id ?? null });
    }
    throw error;
  }

  nudgeReviewDelibsGlobal({ sessionId: session.id, status: session.status });
  return { session: { id: session.id, status: session.status, outlierCount: order.length } };
}

/** Open sessions this user may join: every one for an admin, their own team's for a member. */
export async function getActiveSessions({ client = prisma, user }) {
  const sessions = await client.reviewDelibSession.findMany({
    where: { status: 'ACTIVE' },
    orderBy: { startedAt: 'asc' },
    include: {
      group: { include: groupMemberUserInclude },
      createdBy: { select: { fullName: true } },
      participants: { where: { userId: user.id, leftAt: null }, select: { id: true } }
    }
  });
  return {
    sessions: sessions
      .filter((session) => canWatch(session.group, user))
      .map((session) => ({
        id: session.id,
        groupId: session.groupId,
        groupName: groupName(session.group),
        startedAt: session.startedAt,
        createdByName: session.createdBy?.fullName || null,
        joined: session.participants.length > 0
      }))
  };
}

/** Per team in the admin cycle: the session running now, or the last one held. */
export async function getGroupStatuses({ client = prisma }) {
  const cycle = await resolveAdminCycle(client);
  if (!cycle) return { groups: [] };
  const sessions = await client.reviewDelibSession.findMany({
    where: { cycleId: cycle.id },
    orderBy: { startedAt: 'desc' },
    select: { id: true, groupId: true, status: true, startedAt: true, endedAt: true, _count: { select: { changes: true } } }
  });
  const byGroup = new Map();
  for (const session of sessions) {
    const entry = byGroup.get(session.groupId) || { groupId: session.groupId, open: null, last: null };
    if (session.status === 'ACTIVE' && !entry.open) {
      entry.open = { id: session.id, startedAt: session.startedAt };
    } else if (session.status === 'ENDED' && !entry.last) {
      entry.last = { id: session.id, endedAt: session.endedAt, changeCount: session._count.changes };
    }
    byGroup.set(session.groupId, entry);
  }
  return { groups: [...byGroup.values()] };
}

export async function joinSession({ client = prisma, sessionId, user }) {
  const session = await loadForViewer(client, sessionId, user);
  assertActive(session);

  const participant = await client.reviewDelibParticipant.findUnique({
    where: { sessionId_userId: { sessionId, userId: user.id } }
  });
  const now = Date.now();
  const stillPresent = participant && !participant.leftAt &&
    now - new Date(participant.lastSeenAt).getTime() <= PRESENCE_WINDOW_MS;

  if (stillPresent) {
    await client.reviewDelibParticipant.update({ where: { id: participant.id }, data: { lastSeenAt: new Date(now) } });
  } else {
    const { version } = await lock(client, sessionId, async (tx, locked) => {
      assertActive(locked);
      await tx.reviewDelibParticipant.upsert({
        where: { sessionId_userId: { sessionId, userId: user.id } },
        create: { sessionId, userId: user.id },
        update: { lastSeenAt: new Date(now), leftAt: null }
      });
    });
    nudgeReviewDelib(sessionId, { version, kind: 'presence' });
  }
  return getState({ client, sessionId, user });
}

export async function leaveSession({ client = prisma, sessionId, user }) {
  const participant = await client.reviewDelibParticipant.findUnique({
    where: { sessionId_userId: { sessionId, userId: user.id } },
    select: { leftAt: true }
  });
  if (!participant || participant.leftAt) return;
  const { version } = await lock(client, sessionId, (tx) =>
    tx.reviewDelibParticipant.updateMany({
      where: { sessionId, userId: user.id, leftAt: null },
      data: { leftAt: new Date() }
    }));
  nudgeReviewDelib(sessionId, { version, kind: 'presence' });
}

/**
 * Changes what counts as an outlier, and the walkthrough with it (see
 * rethresholdWalkthrough): raising it drops candidates who no longer qualify,
 * lowering it adds the newly qualifying ones at the end. A candidate the room
 * resolved by an override stays. Each viewer's own place in the walkthrough is
 * theirs to keep; the page moves anyone whose candidate was dropped.
 *
 * The scores are read before taking the lock, which is held only to apply them
 * to the list as it stands, so two threshold changes each apply their own. An
 * override landing between the read and the lock can leave one entry stale
 * until the next change.
 */
export async function setThreshold({ client = prisma, sessionId, user, thresholdPct }) {
  const threshold = normalizeThreshold(thresholdPct);
  const head = await loadHead(client, sessionId);
  const input = await loadTeamInput({ client, groupId: head.groupId, cycleId: head.cycleId, participation: false });
  const stats = computeTeamStats({ ...input, thresholdPct: threshold });

  const { version } = await lock(client, sessionId, async (tx, session) => {
    assertActive(session);
    await assertHost(tx, session, user);
    const before = Array.isArray(session.outlierApplicationIds) ? session.outlierApplicationIds : [];
    await tx.reviewDelibSession.update({
      where: { id: sessionId },
      data: { thresholdPct: threshold, outlierApplicationIds: rethresholdWalkthrough(stats, before) }
    });
  });

  nudgeReviewDelib(sessionId, { version, kind: 'control' });
  return getState({ client, sessionId, user });
}

/**
 * Sets or clears the admin override on one grader's score. Only adminScore is
 * written: the grader's own categories and overall stay as graded, which is
 * what lets the card show "was 4, now 8" and what clearing it restores.
 */
export async function overrideScore({ client = prisma, sessionId, user, type, scoreId, adminScore }) {
  const model = scoreModel(type);
  if (!model) throw fail(400, `Unknown document type: ${type}`, 'INVALID_TYPE');
  const value = adminScore === '' || adminScore === undefined ? null : adminScore;

  const { version } = await lock(client, sessionId, async (tx, session) => {
    assertActive(session);
    await assertHost(tx, session, user);

    const existing = await tx[model].findUnique({
      where: { id: scoreId },
      include: { evaluator: { select: { fullName: true } } }
    });
    if (!existing || existing.cycleId !== session.cycleId) throw fail(404, 'Score not found', 'NOT_FOUND');
    const application = await teamApplication(tx, session, { candidateId: existing.candidateId }, user, { forWrite: true });

    const data = await adminScorePatch({ client: tx, type, existing, body: { adminScore: value } });
    const before = existing.adminScore === null ? null : Number(existing.adminScore);
    if (before === data.adminScore) return;

    await tx[model].update({ where: { id: scoreId }, data: { adminScore: data.adminScore } });
    await tx.reviewDelibChange.create({
      data: {
        sessionId,
        userId: user.id,
        kind: 'SCORE',
        applicationId: application.id,
        candidateId: existing.candidateId,
        docType: type,
        scoreId,
        evaluatorId: existing.evaluatorId,
        fromValue: before === null ? null : String(before),
        toValue: data.adminScore === null ? null : String(data.adminScore),
        originalScore: existing.overallScore
      }
    });
    const grader = existing.evaluator?.fullName || 'a grader';
    const graded = formatScore(Number(existing.overallScore));
    await tx.comment.create({
      data: {
        applicationId: application.id,
        userId: user.id,
        content: data.adminScore === null
          ? `Review team deliberation: cleared the override on ${grader}'s ${docLabel(type)} score (back to ${graded})`
          : `Review team deliberation: ${grader}'s ${docLabel(type)} score overridden ${formatScore(before ?? Number(existing.overallScore))} → ${formatScore(data.adminScore)} (graded ${graded})`
      }
    });
  });

  nudgeReviewDelib(sessionId, { version, kind: 'control' });
  return getState({ client, sessionId, user });
}

/** The Resume Review decision, written exactly as Staging's picker writes it. Empty clears it. */
export async function setDecision({ client = prisma, sessionId, user, applicationId, decision }) {
  const value = decision || null;
  if (value !== null && !isDecisionValue(value)) throw fail(400, `Unknown decision: ${decision}`, 'INVALID_DECISION');

  const { version } = await lock(client, sessionId, async (tx, session) => {
    assertActive(session);
    await assertHost(tx, session, user);

    const application = await teamApplication(tx, session, { id: applicationId }, user, { forWrite: true });
    const before = application.resumeDecision ?? null;
    if (before === value) return;

    await saveRoundDecision({
      client: tx,
      applicationId: application.id,
      cycleId: session.cycleId,
      phase: 'resume',
      decision: value,
      userId: user.id
    });
    await tx.reviewDelibChange.create({
      data: {
        sessionId,
        userId: user.id,
        kind: 'DECISION',
        applicationId: application.id,
        candidateId: application.candidateId,
        fromValue: before,
        toValue: value
      }
    });
  });

  nudgeReviewDelib(sessionId, { version, kind: 'control' });
  return getState({ client, sessionId, user });
}

/** Any admin may end one, joined or not, so a session left open by someone who lost their connection can be closed. */
export async function endSession({ client = prisma, sessionId, user }) {
  if (!isAdmin(user)) throw fail(403, 'Only admins can end a deliberation', 'FORBIDDEN');
  const { version } = await lock(client, sessionId, async (tx, session) => {
    assertActive(session);
    await tx.reviewDelibSession.update({
      where: { id: sessionId },
      data: { status: 'ENDED', endedAt: new Date(), endedById: user.id }
    });
  });
  nudgeReviewDelib(sessionId, { version, kind: 'control' });
  nudgeReviewDelibsGlobal({ sessionId, status: 'ENDED' });
  return getState({ client, sessionId, user });
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function assertJoined(session, participants, user) {
  if (session.status === 'ENDED') return;
  const mine = participants.find((participant) => participant.userId === user.id);
  if (!mine || mine.leftAt) throw fail(403, 'Join the deliberation first', 'NOT_JOINED');
}

/** The light payload everyone polls: the session's shared settings and who is in it. */
export async function getState({ client = prisma, sessionId, user, now = Date.now() }) {
  const head = await client.reviewDelibSession.findUnique({ where: { id: sessionId }, select: { version: true } });
  if (!head) throw fail(404, 'Deliberation not found', 'NOT_FOUND');

  let raw;
  const cached = stateCache.get(sessionId);
  if (cached && cached.version === head.version && now - cached.at <= STATE_CACHE_TTL_MS) {
    raw = cached.raw;
  } else {
    const session = await client.reviewDelibSession.findUnique({
      where: { id: sessionId },
      include: {
        group: { include: groupMemberUserInclude },
        createdBy: { select: { fullName: true } },
        participants: { select: { userId: true, lastSeenAt: true, leftAt: true, user: { select: { fullName: true, role: true, profileImage: true } } } },
        _count: { select: { changes: true } }
      }
    });
    if (!session) throw fail(404, 'Deliberation not found', 'NOT_FOUND');
    raw = session;
    stateCache.set(sessionId, { version: session.version, raw, at: now });
  }

  // Membership from the database, not the cached read: removing someone from a
  // team bumps no session version. Admins always pass, so only members pay.
  const group = isAdmin(user)
    ? raw.group
    : await client.groups.findUnique({ where: { id: raw.groupId }, include: groupMemberUserInclude });
  if (!canWatch(group, user)) {
    throw fail(403, `This deliberation is for ${groupName(raw.group)}`, 'NOT_ON_TEAM', { groupName: groupName(raw.group) });
  }
  assertJoined(raw, raw.participants, user);

  // Heartbeat: throttled, and not a version bump - presence is worked out at read time.
  const mine = raw.participants.find((participant) => participant.userId === user.id);
  if (mine && !mine.leftAt && raw.status === 'ACTIVE' && now - new Date(mine.lastSeenAt).getTime() > HEARTBEAT_EVERY_MS) {
    const seenAt = new Date(now);
    await client.reviewDelibParticipant.updateMany({
      where: { sessionId, userId: user.id, leftAt: null },
      data: { lastSeenAt: seenAt }
    });
    mine.lastSeenAt = seenAt;
  }

  const memberIds = getGroupMemberIds(raw.group);
  const present = (participant) => !participant.leftAt && now - new Date(participant.lastSeenAt).getTime() <= PRESENCE_WINDOW_MS;
  const participants = raw.participants.map((participant) => ({
    userId: participant.userId,
    name: participant.user?.fullName || 'Someone',
    role: participant.user?.role || null,
    profileImage: participant.user?.profileImage || null,
    isTeamMember: memberIds.includes(participant.userId),
    present: present(participant)
  }));
  // Team members who have not joined, so the room can see who is missing.
  const absent = getGroupMemberUsers(raw.group)
    .filter((member) => !participants.some((participant) => participant.userId === member.id))
    .map((member) => ({ userId: member.id, name: member.fullName, role: 'MEMBER', profileImage: member.profileImage || null, isTeamMember: true, present: false }));

  return {
    version: raw.version,
    now,
    session: {
      id: raw.id,
      groupId: raw.groupId,
      groupName: groupName(raw.group),
      cycleId: raw.cycleId,
      status: raw.status,
      thresholdPct: raw.thresholdPct,
      outlierApplicationIds: Array.isArray(raw.outlierApplicationIds) ? raw.outlierApplicationIds : [],
      createdByName: raw.createdBy?.fullName || null,
      startedAt: raw.startedAt,
      endedAt: raw.endedAt
    },
    viewer: {
      userId: user.id,
      isAdmin: isAdmin(user),
      isHost: isAdmin(user) && Boolean(mine && !mine.leftAt) && raw.status === 'ACTIVE'
    },
    participants: [...participants, ...absent],
    changeCount: raw._count.changes
  };
}

/** The overview's numbers and the candidate table. */
export async function getTeamView({ client = prisma, sessionId, user }) {
  const session = await loadForViewer(client, sessionId, user);
  const participants = await client.reviewDelibParticipant.findMany({ where: { sessionId }, select: { userId: true, leftAt: true } });
  assertJoined(session, participants, user);

  const { input, stats } = await teamBundle(client, session);
  const { rows, ...rest } = stats;
  return {
    version: session.version,
    group: input.group,
    members: input.groups.find((group) => group.id === session.groupId)?.members || [],
    ...rest
  };
}

/** One candidate's card: profile, documents, every grader's score on each, events attended and referrals. */
export async function getCandidateCard({ client = prisma, sessionId, applicationId, user }) {
  const session = await loadForViewer(client, sessionId, user);
  const participants = await client.reviewDelibParticipant.findMany({ where: { sessionId }, select: { userId: true, leftAt: true } });
  assertJoined(session, participants, user);

  // Against the database, not the cached bundle: sealing a record or moving the
  // candidate to another team bumps nothing here, and the card is everything
  // about them. 404 off the team, 423 sealed.
  const checked = await teamApplication(client, session, { id: applicationId }, user);

  const { input, stats } = await teamBundle(client, session);
  const candidate = input.candidates.find((entry) => entry.applicationId === applicationId && entry.groupId === session.groupId);
  if (!candidate) throw fail(404, "That candidate is not on this team's list", 'NOT_ON_TEAM_LIST');
  if (candidate.locked) throw fail(423, 'This record is sealed', 'RECORD_LOCKED');

  // Only now, with the seal and the team checked twice over, is anything else
  // about them read. Not cached with the team bundle: it is one candidate's.
  const { attendance, referrals } = await loadParticipation(client, session, checked);

  const memberIds = new Set((input.groups.find((group) => group.id === session.groupId)?.members || []).map((member) => member.id));
  const summary = stats.candidates.find((entry) => entry.applicationId === applicationId);
  const { application } = candidate;
  const docs = {};
  for (const type of DOCUMENT_TYPES) {
    docs[type] = {
      has: candidate.hasDoc[type],
      max: input.maxByType[type],
      categories: (input.rubrics[type]?.rubric?.categories || []).map(({ id, title, min, max }) => ({ id, title, min, max })),
      avg: summary?.perDoc?.[type]?.avg ?? null,
      rows: stats.rows
        .filter((row) => row.candidateId === candidate.candidateId && row.type === type)
        .map((row) => ({ ...row, onTeam: memberIds.has(row.evaluatorId) }))
        .sort((a, b) => Number(b.onTeam) - Number(a.onTeam) || a.evaluatorName.localeCompare(b.evaluatorName))
    };
  }

  return {
    version: session.version,
    applicationId,
    candidateId: candidate.candidateId,
    cycleId: application.cycleId,
    name: candidate.name,
    major: application.major1 || null,
    major2: application.major2 || null,
    year: application.graduationYear || null,
    gpa: application.cumulativeGpa === null || application.cumulativeGpa === undefined ? null : String(application.cumulativeGpa),
    headshotUrl: application.headshotUrl || null,
    resumeUrl: application.resumeUrl || null,
    coverLetterUrl: application.coverLetterUrl || null,
    shortAnswer: application.shortAnswer || null,
    videoUrl: application.videoUrl || null,
    resumeDecision: application.resumeDecision ?? null,
    total: summary?.total ?? null,
    participation: summary?.participation ?? null,
    overall: summary?.overall ?? null,
    overallMax: stats.overallMax ?? null,
    rank: summary?.rank ?? null,
    rankedCount: stats.rankedCount ?? 0,
    outlierCount: summary?.outlierCount ?? 0,
    splitDocs: summary?.splitDocs ?? 0,
    attendance,
    referrals,
    docs
  };
}

/**
 * What the card shows besides grades: the cycle's events they came to and who
 * referred them, as Application Detail reads them. The whole room sees this, so
 * it carries names and words only, never a referrer's email or user id.
 *
 * `attendedCount` of `eventCount` counts the cycle's own events. Get to Know UC
 * is in `attended` (with `isMeeting`) when they came to one, but in neither
 * number: it is not an event of the cycle, and counting it would allow "4 of 3".
 */
// A member with no full name is stored by address (member.js falls back to
// req.user.email), and a typed name can be a pasted address. Neither goes on a
// screen the whole room sees.
const looksLikeEmail = (value) => typeof value === 'string' && value.includes('@');

/**
 * Who referred them, as the room may see it. A member's submission names the
 * member's current account; a manual one only has the name typed on
 * Application Detail.
 */
function referrerNameFor(referral) {
  const name = [
    referral.source === 'PRE_APPLICATION' ? referral.referredBy?.fullName : null,
    referral.referrerName
  ].map((value) => (typeof value === 'string' ? value.trim() : '')).find((value) => value && !looksLikeEmail(value));
  if (name) return name;
  return referral.source === 'PRE_APPLICATION' ? 'A member' : 'Name not given';
}

async function loadParticipation(client, session, application) {
  const [events, referrals] = await Promise.all([
    client.recruitingCycle
      .findUnique({ where: { id: session.cycleId }, select: { startDate: true, endDate: true } })
      .then((cycle) => getCycleEventParticipation({
        client,
        cycleId: session.cycleId,
        candidateId: application.candidateId,
        studentId: application.candidate?.studentId || application.studentId,
        cycleStartDate: cycle?.startDate,
        cycleEndDate: cycle?.endDate
      })),
    application.candidateId
      ? getCycleReferrals({ client, candidateId: application.candidateId, cycleId: session.cycleId })
      : []
  ]);

  const cycleEvents = events.events.filter((event) => !event.isMeeting);
  return {
    attendance: {
      attended: events.events
        .filter((event) => event.attendanceStatus === 'Attended')
        .map((event) => ({
          id: event.id,
          name: event.eventName,
          startDate: event.eventStartDate,
          ...(event.isMeeting && { isMeeting: true })
        })),
      attendedCount: cycleEvents.filter((event) => event.attendanceStatus === 'Attended').length,
      eventCount: cycleEvents.length
    },
    referrals: referrals.map((referral) => ({
      id: referral.id,
      source: referral.source,
      referrerName: referrerNameFor(referral),
      relationship: referral.relationship || null,
      reason: referral.reason || null
    }))
  };
}

/**
 * What the session changed, netted: a score overridden twice is one change from
 * its first value to its last, and one put back where it started is no change.
 */
export async function getChanges({ client = prisma, sessionId, user }) {
  const session = await loadForViewer(client, sessionId, user);
  const participants = await client.reviewDelibParticipant.findMany({ where: { sessionId }, select: { userId: true, leftAt: true } });
  assertJoined(session, participants, user);

  const changes = await client.reviewDelibChange.findMany({ where: { sessionId }, orderBy: { createdAt: 'asc' } });
  const netted = new Map();
  for (const change of changes) {
    const key = change.kind === 'SCORE' ? `S:${change.scoreId}` : `D:${change.applicationId}`;
    const entry = netted.get(key);
    if (entry) {
      entry.toValue = change.toValue;
      entry.userId = change.userId;
      entry.createdAt = change.createdAt;
    } else {
      netted.set(key, { ...change });
    }
  }
  const kept = [...netted.values()].filter((change) => change.fromValue !== change.toValue);

  const applicationIds = [...new Set(kept.map((change) => change.applicationId))];
  const userIds = [...new Set(kept.flatMap((change) => [change.userId, change.evaluatorId]).filter(Boolean))];
  const [applications, users, sealed] = await Promise.all([
    client.application.findMany({ where: { id: { in: applicationIds } }, select: { id: true, firstName: true, lastName: true } }),
    client.user.findMany({ where: { id: { in: userIds } }, select: { id: true, fullName: true } }),
    sealedApplicationIds(applicationIds, client)
  ]);
  const nameOf = new Map(applications.map((application) => [application.id, `${application.firstName} ${application.lastName}`.trim()]));
  const userName = new Map(users.map((entry) => [entry.id, entry.fullName]));

  return {
    total: changes.length,
    changes: kept
      .filter((change) => !sealed.has(change.applicationId))
      .map((change) => ({
        id: change.id,
        kind: change.kind,
        applicationId: change.applicationId,
        candidateName: nameOf.get(change.applicationId) || 'Unknown candidate',
        docType: change.docType,
        graderName: change.evaluatorId ? userName.get(change.evaluatorId) || 'Unknown grader' : null,
        originalScore: change.originalScore === null ? null : Number(change.originalScore),
        fromValue: change.fromValue,
        toValue: change.toValue,
        byName: userName.get(change.userId) || 'An admin',
        at: change.createdAt
      }))
      .sort((a, b) => a.candidateName.localeCompare(b.candidateName) || a.kind.localeCompare(b.kind))
  };
}
