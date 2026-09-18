import prisma from '../prismaClient.js';

// A case a MEMBER is assigned to but may not read yet answers 423 with this
// code, so the client can tell "too early" apart from "not yours" (403).
// Mirrors RECORD_LOCKED in utils/lockedRecords.js.
export const CASE_LOCKED_CODE = 'CASE_LOCKED';

const SETTING_ID = 'singleton';

// Used when the settings row has not been created yet, and as the column
// default in the migration. Keep the three in step.
export const DEFAULT_LEAD_TIME_HOURS = 2;

// 30 days. Larger numbers mean EARLIER access, so this end of the range is
// "effectively no restriction" rather than the strict end.
export const MAX_LEAD_TIME_HOURS = 720;

const MS_PER_HOUR = 60 * 60 * 1000;

// Prisma's code for "the table is not there". This project applies migrations by
// hand (see CLAUDE.md), so the code can reach a database that has not had this
// one run yet. Reads fall back to the default rather than taking the whole case
// book down; writes still fail, loudly, because a setting that cannot be saved
// must not look saved.
const MISSING_TABLE = 'P2021';

function isMissingTable(error) {
  return error?.code === MISSING_TABLE;
}

async function readSetting() {
  try {
    return await prisma.caseVisibilitySetting.findUnique({
      where: { id: SETTING_ID },
      select: { leadTimeHours: true, updatedAt: true, updatedById: true },
    });
  } catch (error) {
    if (isMissingTable(error)) {
      console.error(
        '[caseVisibility] case_visibility_settings is missing — run the migration. ' +
          `Falling back to ${DEFAULT_LEAD_TIME_HOURS}h until it exists.`
      );
      return null;
    }
    throw error;
  }
}

export async function getLeadTimeHours() {
  const row = await readSetting();
  return row?.leadTimeHours ?? DEFAULT_LEAD_TIME_HOURS;
}

export async function getVisibilitySetting() {
  const row = await readSetting();
  return {
    leadTimeHours: row?.leadTimeHours ?? DEFAULT_LEAD_TIME_HOURS,
    updatedAt: row?.updatedAt ?? null,
    updatedById: row?.updatedById ?? null,
  };
}

// Throws on a value the admin UI should have rejected; the route turns that
// into a 400.
export async function setLeadTimeHours(hours, userId) {
  if (!Number.isInteger(hours) || hours < 0 || hours > MAX_LEAD_TIME_HOURS) {
    const error = new Error(
      `leadTimeHours must be a whole number between 0 and ${MAX_LEAD_TIME_HOURS}`
    );
    error.code = 'INVALID_LEAD_TIME';
    throw error;
  }
  const row = await prisma.caseVisibilitySetting.upsert({
    where: { id: SETTING_ID },
    update: { leadTimeHours: hours, updatedById: userId ?? null },
    create: { id: SETTING_ID, leadTimeHours: hours, updatedById: userId ?? null },
    select: { leadTimeHours: true, updatedAt: true, updatedById: true },
  });
  return row;
}

// When a member may start reading a case used by an interview starting at
// `startDate`. Exported for tests and for anything that wants to show the time
// without re-deriving the arithmetic.
export function unlockTimeFor(startDate, leadTimeHours) {
  return new Date(new Date(startDate).getTime() - leadTimeHours * MS_PER_HOUR);
}

/**
 * May this user read this case's content right now?
 *
 * Returns one of:
 *   { allowed: true }
 *   { allowed: false, reason: 'FORBIDDEN' }                  -- not theirs at all
 *   { allowed: false, reason: 'LOCKED', unlocksAt: Date }    -- theirs, too early
 *
 * A MEMBER is assigned through InterviewAssignment on an interview that has
 * this case. Where several of their interviews use the same case, the earliest
 * unlock wins: access opens as soon as the first of them is near enough. An
 * interview already under way or past is never locked, since its unlock time
 * has gone by.
 */
export async function authorizeCaseRead(caseId, user, now = new Date()) {
  if (user.role === 'ADMIN') return { allowed: true };
  if (user.role !== 'MEMBER') return { allowed: false, reason: 'FORBIDDEN' };

  const links = await prisma.caseAssignment.findMany({
    where: {
      caseId,
      interview: { assignments: { some: { userId: user.id } } },
    },
    select: { interview: { select: { startDate: true } } },
  });
  if (links.length === 0) return { allowed: false, reason: 'FORBIDDEN' };

  const leadTimeHours = await getLeadTimeHours();
  const unlockTimes = links.map((link) => unlockTimeFor(link.interview.startDate, leadTimeHours));
  const earliest = unlockTimes.reduce((a, b) => (a <= b ? a : b));

  if (earliest.getTime() <= now.getTime()) return { allowed: true };
  return { allowed: false, reason: 'LOCKED', unlocksAt: earliest };
}
