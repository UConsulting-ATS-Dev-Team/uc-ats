// A tutorial gate makes someone sit through a category's tutorials before they do that
// kind of work for the first time in a cycle. Document grading gates the first document
// a member or admin opens to grade each cycle; each interview round gates the first
// interview of that round they start (COFFEE_CHATS, FIRST_ROUND, FINAL_ROUND - see
// tutorialCategoryForInterviewType in client/src/utils/tutorialCategories.js).
//
// The tutorials are whatever admins have published in Help Management, so the gate has
// nothing hard-coded to show. A category with no tutorials does not gate at all - an
// empty popup that blocks grading would be worse than none.
//
// The gate fails open: no current cycle, or an unapplied migration, reads as "not
// required". Missing a tutorial is recoverable; nobody being able to grade is not.
import crypto from 'node:crypto';
import config from '../config.js';
import prisma from '../prismaClient.js';
import { resolveCycleForRequest } from './activeCycle.js';

export const GATED_CATEGORIES = Object.freeze([
  'DOCUMENT_GRADING',
  'COFFEE_CHATS',
  'FIRST_ROUND',
  'FINAL_ROUND',
]);

export const isGatedCategory = (category) => GATED_CATEGORIES.includes(category);

const GATED_ROLES = new Set(['ADMIN', 'MEMBER']);

// P2021: table does not exist. Lets this deploy ahead of its migration.
const isMissingTable = (error) => error?.code === 'P2021';

/**
 * Whether `req.user` still has to sit through `category`'s tutorials this cycle, and
 * the tutorials to show if so.
 */
export async function getTutorialGate(req, category) {
  const notRequired = { required: false, cycleId: null, tutorials: [] };
  if (!isGatedCategory(category) || !GATED_ROLES.has(req.user?.role)) return notRequired;

  const cycle = await resolveCycleForRequest(prisma, req);
  if (!cycle) return notRequired;

  const tutorials = await prisma.tutorial.findMany({
    where: { category },
    orderBy: [{ order: 'asc' }, { createdAt: 'desc' }],
  });
  if (tutorials.length === 0) return { ...notRequired, cycleId: cycle.id };

  try {
    const completion = await prisma.tutorialCompletion.findUnique({
      where: {
        userId_cycleId_category: { userId: req.user.id, cycleId: cycle.id, category },
      },
      select: { id: true },
    });
    if (completion) return { ...notRequired, cycleId: cycle.id };
  } catch (error) {
    if (isMissingTable(error)) return { ...notRequired, cycleId: cycle.id };
    throw error;
  }

  return { required: true, cycleId: cycle.id, token: gateToken(req.user.id, cycle.id, category), tutorials };
}

// Proof that this server showed `userId` the gate for `cycleId`: completing a cycle
// other than the current one needs it, so a client cannot name a cycle it was never
// shown and mark its tutorials done.
const gateToken = (userId, cycleId, category) =>
  crypto
    .createHmac('sha256', config.jwtSecret || '')
    .update(`tutorial-gate|${userId}|${cycleId}|${category}`)
    .digest('base64url');

const validGateToken = (token, userId, cycleId, category) => {
  if (typeof token !== 'string' || !config.jwtSecret) return false;
  const expected = Buffer.from(gateToken(userId, cycleId, category));
  const given = Buffer.from(token);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given);
};

/**
 * Records that `req.user` finished `category`'s tutorials. Idempotent: finishing twice
 * is one row. Returns the completion for the *current* cycle, or null when there is
 * none - no current cycle, or it is not the one they were shown.
 *
 * `shown` is { cycleId, token } from the getTutorialGate answer the popup opened with.
 * The current cycle can move while someone watches:
 * - The current cycle is credited only when it is the one they were shown. Crediting a
 *   cycle that moved in under the popup would let them skip its tutorials; instead
 *   they get null, and the popup asks the gate again.
 * - The shown cycle is still credited, so the tutorial they did watch counts if that
 *   cycle comes back - but only with the token this server signed for it. Without
 *   that, a client could name any cycle and pre-complete it.
 */
export async function completeTutorialGate(req, category, shown = {}) {
  const cycle = await resolveCycleForRequest(prisma, req);
  if (!cycle) return null;
  const { cycleId: shownCycleId = null, token = null } = shown;
  if (!shownCycleId || shownCycleId === cycle.id) return record(req.user.id, cycle.id, category);

  if (validGateToken(token, req.user.id, shownCycleId, category)) {
    try {
      await record(req.user.id, shownCycleId, category);
    } catch (error) {
      // Deleted since the popup opened: there is nothing left to credit.
      if (!isMissingCycle(error)) throw error;
    }
  }
  return null;
}

// P2003: foreign key - the cycle no longer exists.
const isMissingCycle = (error) => error?.code === 'P2003';

const record = (userId, cycleId, category) =>
  prisma.tutorialCompletion.upsert({
    where: { userId_cycleId_category: { userId, cycleId, category } },
    update: {},
    create: { userId, cycleId, category },
  });
