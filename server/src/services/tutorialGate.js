// A tutorial gate makes someone sit through a category's tutorials before they do that
// kind of work for the first time in a cycle. Document grading gates the first document
// a member or admin opens to grade each cycle; each interview round gates the first
// interview of that round they start (COFFEE_CHATS, FIRST_ROUND, FINAL_ROUND - see
// tutorialCategoryForInterviewType in client/src/utils/tutorialGates.js).
//
// The tutorials are whatever admins have published in Help Management, so the gate has
// nothing hard-coded to show. A category with no tutorials does not gate at all - an
// empty popup that blocks grading would be worse than none.
//
// The gate fails open: no current cycle, or an unapplied migration, reads as "not
// required". Missing a tutorial is recoverable; nobody being able to grade is not.
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

  return { required: true, cycleId: cycle.id, tutorials };
}

/**
 * Records that `req.user` finished `category`'s tutorials in the current cycle.
 * Idempotent: finishing twice is one row. Returns null when there is no cycle to
 * record against.
 */
export async function completeTutorialGate(req, category) {
  const cycle = await resolveCycleForRequest(prisma, req);
  if (!cycle) return null;

  return prisma.tutorialCompletion.upsert({
    where: {
      userId_cycleId_category: { userId: req.user.id, cycleId: cycle.id, category },
    },
    update: {},
    create: { userId: req.user.id, cycleId: cycle.id, category },
  });
}
