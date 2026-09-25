// Member accountability points.
//
// Every member owes the club a target number of points per cycle (3 by default),
// earned by taking part in recruiting. Each *type* of participation counts once:
// sitting on two first rounds is worth the same as sitting on one, so the list
// reads as a checklist of what is left rather than a grind.
//
// The types, their labels and where their credit comes from are code. What each
// is worth and the target are admin-editable (accountability_point_values and
// accountability_settings); a type without a row is worth its default.
//
// Credit is read from records the ATS already keeps, never entered twice:
//
//   GTKUC                hosted a GTKUC slot somebody attended, inside the cycle's dates
//   APPLICATION_SCREEN   submitted a resume, cover letter or video score this cycle
//   interview types      sat on a session of that interview type that has started
//   event types          checked in to a cycle event an admin tagged with that type
//
// Nothing in this file decides who may see or send what; the routes do that.
import prisma from '../prismaClient.js';
import { interviewersWhoHaveSat } from './interviewRoster.js';
import { sendEmail } from './emailNotifications.js';
import { copyHtml, copyLine, copySubject } from './emailCopyRender.js';

export const POINT_TYPES = Object.freeze([
  { key: 'GTKUC', label: 'GTKUC', defaultPoints: 0.5, source: 'GTKUC', howTo: 'Host a GTKUC chat that somebody attends' },
  { key: 'INFO_SESSION', label: 'Info Sesh', defaultPoints: 0.5, source: 'EVENT', howTo: 'Attend an info session' },
  { key: 'WOMENS_NIGHT', label: "Women's Night", defaultPoints: 0.5, source: 'EVENT', howTo: "Attend Women's Night" },
  { key: 'CASE_WORKSHOP', label: 'Case Workshop', defaultPoints: 0.5, source: 'EVENT', howTo: 'Attend a case workshop' },
  { key: 'APPLICATION_SCREEN', label: 'Application Screen', defaultPoints: 1, source: 'SCREEN', howTo: 'Grade applications with your review team' },
  { key: 'COFFEE_CHATS', label: 'Coffee Chats', defaultPoints: 1, source: 'INTERVIEW', interviewType: 'COFFEE_CHAT', howTo: 'Sign up to interview at coffee chats' },
  { key: 'FIRST_ROUND', label: 'First Round Interviews', defaultPoints: 1, source: 'INTERVIEW', interviewType: 'ROUND_ONE', howTo: 'Sign up to interview at first rounds' },
  { key: 'CASE_BUDDIES', label: 'Case Buddies', defaultPoints: 0.5, source: 'EVENT', howTo: 'Be a case buddy' },
  { key: 'FINAL_ROUND', label: 'Final Round Interviews', defaultPoints: 1, source: 'INTERVIEW', interviewType: 'FINAL_ROUND', howTo: 'Sign up to interview at final rounds' },
].map(Object.freeze));

export const DEFAULT_TARGET_POINTS = 3;

/** The types an admin can tag an event with. */
export const EVENT_POINT_TYPES = Object.freeze(POINT_TYPES.filter((t) => t.source === 'EVENT').map((t) => t.key));

export const isEventPointType = (key) => EVENT_POINT_TYPES.includes(key);

// Points are stored with two decimals and added up in hundredths, so 0.5 six
// times is 3 and not 2.9999999999999996 - a member one float short of the
// target would otherwise get a reminder they do not deserve.
const toHundredths = (value) => Math.round(Number(value) * 100);
const fromHundredths = (value) => value / 100;

const MAX_POINTS = 99.99; // DECIMAL(4,2)

// Prisma's "table does not exist". Migrations here are applied by hand (see
// CLAUDE.md), so reads fall back to the defaults until this one is run; writes
// still fail loudly, because a value that cannot be saved must not look saved.
const MISSING_TABLE = 'P2021';

async function readOrNull(read, table) {
  try {
    return await read();
  } catch (error) {
    if (error?.code === MISSING_TABLE) {
      console.error(`[accountabilityPoints] ${table} is missing. Run the migration; using defaults until then.`);
      return null;
    }
    throw error;
  }
}

/** Every type with its current value, plus the target. */
export async function loadPointConfig(client = prisma) {
  const [rows, setting] = await Promise.all([
    readOrNull(() => client.accountabilityPointValue.findMany(), 'accountability_point_values'),
    readOrNull(() => client.accountabilitySetting.findUnique({ where: { id: 'singleton' } }), 'accountability_settings'),
  ]);
  const stored = new Map((rows ?? []).map((row) => [row.type, Number(row.points)]));

  return {
    targetPoints: setting ? Number(setting.targetPoints) : DEFAULT_TARGET_POINTS,
    types: POINT_TYPES.map((type) => ({
      key: type.key,
      label: type.label,
      source: type.source,
      howTo: type.howTo,
      defaultPoints: type.defaultPoints,
      points: stored.get(type.key) ?? type.defaultPoints,
    })),
  };
}

const invalid = (message) => Object.assign(new Error(message), { code: 'INVALID_ACCOUNTABILITY_CONFIG' });

function checkPoints(value, what, { allowZero }) {
  const number = Number(value);
  if (value === null || value === '' || !Number.isFinite(number)) throw invalid(`${what} must be a number`);
  if (number < 0 || (!allowZero && number === 0)) throw invalid(`${what} must be ${allowZero ? 'zero or more' : 'more than zero'}`);
  if (number > MAX_POINTS) throw invalid(`${what} must be at most ${MAX_POINTS}`);
  if (Math.abs(toHundredths(number) - number * 100) > 1e-6) throw invalid(`${what} can have at most two decimal places`);
  return fromHundredths(toHundredths(number));
}

/**
 * Save new values. `points` is { TYPE: number } and may name any subset of the
 * types; `targetPoints` is optional. Everything is validated before anything is
 * written, so a bad value leaves the rest unsaved too. Throws with code
 * INVALID_ACCOUNTABILITY_CONFIG for the route to answer 400.
 */
export async function updatePointConfig({ points = {}, targetPoints } = {}, userId = null, client = prisma) {
  if (!points || typeof points !== 'object' || Array.isArray(points)) throw invalid('points must be an object');

  const updates = Object.entries(points).map(([key, value]) => {
    const type = POINT_TYPES.find((t) => t.key === key);
    if (!type) throw invalid(`Unknown point type: ${key}`);
    return { key, points: checkPoints(value, type.label, { allowZero: true }) };
  });
  const target = targetPoints === undefined ? undefined : checkPoints(targetPoints, 'Target', { allowZero: false });

  await client.$transaction([
    ...updates.map(({ key, points: value }) =>
      client.accountabilityPointValue.upsert({
        where: { type: key },
        update: { points: value, updatedById: userId },
        create: { type: key, points: value, updatedById: userId },
      })
    ),
    ...(target === undefined
      ? []
      : [
          client.accountabilitySetting.upsert({
            where: { id: 'singleton' },
            update: { targetPoints: target, updatedById: userId },
            create: { id: 'singleton', targetPoints: target, updatedById: userId },
          }),
        ]),
  ]);

  return loadPointConfig(client);
}

// GTKUC slots carry no cycle, so the cycle's dates are the only way to tell
// this cycle's from last cycle's. A cycle with no start date starts when it was
// created, or every attended slot ever would count toward it.
function cycleWindow(cycle) {
  const window = {};
  const start = cycle?.startDate ?? cycle?.createdAt;
  if (start) window.gte = start;
  if (cycle?.endDate) window.lte = cycle.endDate;
  return Object.keys(window).length ? window : null;
}

/**
 * Which types each of `memberIds` has done in `cycle`, as Map<memberId, Set<type>>.
 * Every member asked about is in the map, with an empty set if they have done nothing.
 */
export async function loadCompletions({ cycle, memberIds, now = new Date() }, client = prisma) {
  const completions = new Map(memberIds.map((id) => [id, new Set()]));
  if (!memberIds.length) return completions;

  const credit = (memberId, type) => completions.get(memberId)?.add(type);
  const window = cycleWindow(cycle);
  const interviewTypes = POINT_TYPES.filter((t) => t.source === 'INTERVIEW');
  // The legacy /applications/:id/grades route saved resume scores without a
  // cycle. Those count when the candidate applied in this cycle and the score
  // was written during it: a candidate who reapplies must not hand last
  // cycle's grader a point for this one.
  const legacyScore = { cycleId: null, candidate: { applications: { some: { cycleId: cycle.id } } } };
  const scoreWhere = {
    evaluatorId: { in: memberIds },
    OR: [{ cycleId: cycle.id }, ...(window ? [{ ...legacyScore, createdAt: window }] : [])],
  };

  const [gtkucSlots, eventAttendance, resumeScores, coverLetterScores, videoScores, interviews] = await Promise.all([
    client.meetingSlot.findMany({
      where: {
        memberId: { in: memberIds },
        signups: { some: { attended: true } },
        ...(window ? { startTime: window } : {}),
      },
      select: { memberId: true },
    }),
    client.memberEventAttendance.findMany({
      where: { memberId: { in: memberIds }, event: { cycleId: cycle.id, pointType: { in: EVENT_POINT_TYPES } } },
      select: { memberId: true, event: { select: { pointType: true } } },
    }),
    client.resumeScore.findMany({ where: scoreWhere, select: { evaluatorId: true }, distinct: ['evaluatorId'] }),
    client.coverLetterScore.findMany({ where: scoreWhere, select: { evaluatorId: true }, distinct: ['evaluatorId'] }),
    client.videoScore.findMany({ where: scoreWhere, select: { evaluatorId: true }, distinct: ['evaluatorId'] }),
    client.interview.findMany({
      where: {
        cycleId: cycle.id,
        status: { not: 'CANCELLED' },
        interviewType: { in: interviewTypes.map((t) => t.interviewType) },
      },
      select: { id: true, interviewType: true, startDate: true, description: true },
    }),
  ]);

  for (const slot of gtkucSlots) credit(slot.memberId, 'GTKUC');
  for (const row of eventAttendance) credit(row.memberId, row.event.pointType);
  for (const row of [...resumeScores, ...coverLetterScores, ...videoScores]) credit(row.evaluatorId, 'APPLICATION_SCREEN');

  const typeByInterview = new Map(
    interviews.map((interview) => [interview.id, interviewTypes.find((t) => t.interviewType === interview.interviewType).key])
  );
  for (const { interviewId, userId } of await interviewersWhoHaveSat(interviews, { now }, client)) {
    credit(userId, typeByInterview.get(interviewId));
  }

  return completions;
}

/** One member's standing, from the config and the set of types they have done. Pure. */
export function scoreMember(config, completedTypes) {
  const done = completedTypes ?? new Set();
  const types = config.types.map((type) => ({ ...type, done: done.has(type.key) }));
  const earned = types.filter((t) => t.done).reduce((sum, t) => sum + toHundredths(t.points), 0);
  const target = toHundredths(config.targetPoints);

  return {
    points: fromHundredths(earned),
    targetPoints: config.targetPoints,
    remainingPoints: fromHundredths(Math.max(0, target - earned)),
    met: earned >= target,
    types,
  };
}

/** Standing for every member in `members`, in the order given. */
export async function scoreMembers({ cycle, members, now }, client = prisma) {
  const [config, completions] = await Promise.all([
    loadPointConfig(client),
    loadCompletions({ cycle, memberIds: members.map((m) => m.id), now }, client),
  ]);
  return {
    config,
    members: members.map((member) => ({ ...member, ...scoreMember(config, completions.get(member.id)) })),
  };
}

// ---------------------------------------------------------------------------
// Reminders
// ---------------------------------------------------------------------------

export const DEFAULT_REMINDER_SUBJECT = 'Accountability reminder: {{points}} of {{targetPoints}} points';
export const DEFAULT_REMINDER_MESSAGE = [
  'Hi {{firstName}},',
  '',
  "Quick reminder that every member needs {{targetPoints}} accountability points this cycle. You're at **{{points}}**, so you need **{{remainingPoints}}** more.",
].join('\n');

export const REMINDER_MERGE_FIELDS = ['firstName', 'fullName', 'points', 'targetPoints', 'remainingPoints'];

const formatPoints = (value) => String(Number(value));

function reminderValues(member) {
  return {
    firstName: (member.fullName || '').trim().split(/\s+/)[0] || 'there',
    fullName: member.fullName || '',
    points: formatPoints(member.points),
    targetPoints: formatPoints(member.targetPoints),
    remainingPoints: formatPoints(member.remainingPoints),
  };
}

/** Subject and HTML for one member's reminder. The checklist under the message is always generated. */
export function renderReminder(member, { subject = DEFAULT_REMINDER_SUBJECT, message = DEFAULT_REMINDER_MESSAGE, cycleName, dashboardUrl }) {
  const values = reminderValues(member);
  const row = (type) => `
            <tr>
              <td style="padding: 4px 8px 4px 0; color: ${type.done ? '#2e7d32' : '#333'};">${type.done ? '&#10003;' : '&#9675;'}</td>
              <td style="padding: 4px 8px 4px 0; color: ${type.done ? '#888' : '#333'};">${copyLine(type.label, {})}${type.done ? '' : `<br><span style="color: #888; font-size: 13px;">${copyLine(type.howTo, {})}</span>`}</td>
              <td style="padding: 4px 0; text-align: right; color: ${type.done ? '#888' : '#333'}; white-space: nowrap;">${formatPoints(type.points)} pt</td>
            </tr>`;
  const open = member.types.filter((t) => !t.done && t.points > 0);
  const done = member.types.filter((t) => t.done);

  return {
    subject: copySubject(subject, values),
    html: `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background-color: #f8f9fa; padding: 20px; text-align: center;">
          <h2 style="color: #333; margin: 0;">UConsulting ATS</h2>
        </div>

        <div style="padding: 30px 20px;">
          ${copyHtml(message, values)}

          <div style="background-color: #f8f9fa; padding: 20px; border-radius: 8px; margin: 20px 0;">
            <h4 style="color: #333; margin: 0 0 10px 0;">${cycleName ? `${copyLine(cycleName, {})}: ` : ''}${values.points} of ${values.targetPoints} points</h4>
            <table style="width: 100%; border-collapse: collapse; font-size: 14px;">${open.map(row).join('')}${done.map(row).join('')}
            </table>
          </div>

          ${dashboardUrl ? `<p style="text-align: center; margin: 30px 0;">
            <a href="${dashboardUrl}" style="background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; display: inline-block;">See your points</a>
          </p>` : ''}
        </div>

        <div style="background-color: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 12px;">
          <p style="margin: 0;">This is an automated message. Please do not reply to this email.</p>
        </div>
      </div>
    `,
  };
}

/**
 * Email each of `members` (already scored) their reminder, one at a time.
 * Never throws for a single failed send; returns { sent, failed: [{ id, email, error }] }.
 */
export async function sendReminders(members, { subject, message, cycle, triggeredById, dashboardUrl }) {
  const sent = [];
  const failed = [];
  for (const member of members) {
    const { subject: renderedSubject, html } = renderReminder(member, { subject, message, cycleName: cycle?.name, dashboardUrl });
    const result = await sendEmail(member.email, renderedSubject, html, [], {
      category: 'ACCOUNTABILITY_REMINDER',
      trigger: 'MANUAL',
      recipientName: member.fullName,
      triggeredById,
      cycleId: cycle?.id ?? null,
    });
    if (result.success) sent.push(member.id);
    else failed.push({ id: member.id, email: member.email, error: result.error });
  }
  return { sent, failed };
}
