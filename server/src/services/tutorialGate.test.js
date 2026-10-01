// The grading tutorial gate blocks the first document someone opens each cycle. These
// pin down who it blocks, when it lets them through, and that it never blocks grading
// for a reason the grader cannot fix.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { resolveCycleForRequest } from './activeCycle.js';
import { completeTutorialGate, getTutorialGate } from './tutorialGate.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    tutorial: { findMany: vi.fn() },
    tutorialCompletion: { findUnique: vi.fn(), upsert: vi.fn() },
    recruitingCycle: { findUnique: vi.fn() },
  },
}));

vi.mock('./activeCycle.js', () => ({ resolveCycleForRequest: vi.fn() }));

const CYCLE = { id: 'cycle-fall' };
const TUTORIAL = { id: 'tut-1', title: 'How we grade', category: 'DOCUMENT_GRADING' };

const asRole = (role, id = `${role.toLowerCase()}-1`) => ({ user: { id, role } });

beforeEach(() => {
  vi.clearAllMocks();
  resolveCycleForRequest.mockResolvedValue(CYCLE);
  prisma.tutorial.findMany.mockResolvedValue([TUTORIAL]);
  prisma.tutorialCompletion.findUnique.mockResolvedValue(null);
});

describe('getTutorialGate', () => {
  it.each(['MEMBER', 'ADMIN'])('requires a %s who has not finished it this cycle', async (role) => {
    const gate = await getTutorialGate(asRole(role), 'DOCUMENT_GRADING');
    expect(gate).toEqual({ required: true, cycleId: CYCLE.id, tutorials: [TUTORIAL] });
  });

  it.each(['COFFEE_CHATS', 'FIRST_ROUND', 'FINAL_ROUND'])(
    'gates the %s interview round on its own tutorials and completion',
    async (category) => {
      const roundTutorial = { ...TUTORIAL, category };
      prisma.tutorial.findMany.mockResolvedValue([roundTutorial]);

      const gate = await getTutorialGate(asRole('MEMBER', 'm-7'), category);

      expect(gate).toEqual({ required: true, cycleId: CYCLE.id, tutorials: [roundTutorial] });
      expect(prisma.tutorial.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { category } }));
      expect(prisma.tutorialCompletion.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId_cycleId_category: { userId: 'm-7', cycleId: CYCLE.id, category } },
        })
      );
    }
  );

  it('does not gate the general interview category', async () => {
    const gate = await getTutorialGate(asRole('MEMBER'), 'INTERVIEW_CONDUCT');
    expect(gate.required).toBe(false);
  });

  it('looks the completion up for this person, this cycle and this category', async () => {
    await getTutorialGate(asRole('MEMBER', 'm-42'), 'DOCUMENT_GRADING');
    expect(prisma.tutorialCompletion.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          userId_cycleId_category: {
            userId: 'm-42',
            cycleId: CYCLE.id,
            category: 'DOCUMENT_GRADING',
          },
        },
      })
    );
  });

  it('lets someone through once they finished it this cycle', async () => {
    prisma.tutorialCompletion.findUnique.mockResolvedValue({ id: 'done' });
    const gate = await getTutorialGate(asRole('MEMBER'), 'DOCUMENT_GRADING');
    expect(gate.required).toBe(false);
  });

  it('does not gate when no grading tutorial has been published', async () => {
    prisma.tutorial.findMany.mockResolvedValue([]);
    const gate = await getTutorialGate(asRole('MEMBER'), 'DOCUMENT_GRADING');
    expect(gate.required).toBe(false);
    expect(prisma.tutorialCompletion.findUnique).not.toHaveBeenCalled();
  });

  it('does not gate when there is no current cycle', async () => {
    resolveCycleForRequest.mockResolvedValue(null);
    const gate = await getTutorialGate(asRole('MEMBER'), 'DOCUMENT_GRADING');
    expect(gate.required).toBe(false);
  });

  it('does not gate a candidate', async () => {
    const gate = await getTutorialGate(asRole('USER'), 'DOCUMENT_GRADING');
    expect(gate.required).toBe(false);
    expect(prisma.tutorial.findMany).not.toHaveBeenCalled();
  });

  it('does not gate a category that has no gate', async () => {
    const gate = await getTutorialGate(asRole('MEMBER'), 'GTKUC');
    expect(gate.required).toBe(false);
  });

  it('does not gate before the migration is applied', async () => {
    prisma.tutorialCompletion.findUnique.mockRejectedValue(
      Object.assign(new Error('missing table'), { code: 'P2021' })
    );
    const gate = await getTutorialGate(asRole('MEMBER'), 'DOCUMENT_GRADING');
    expect(gate.required).toBe(false);
  });

  it('surfaces any other database error', async () => {
    prisma.tutorialCompletion.findUnique.mockRejectedValue(new Error('connection refused'));
    await expect(getTutorialGate(asRole('MEMBER'), 'DOCUMENT_GRADING')).rejects.toThrow(
      'connection refused'
    );
  });
});

describe('completeTutorialGate', () => {
  it('records the completion against the current cycle, idempotently', async () => {
    prisma.tutorialCompletion.upsert.mockResolvedValue({ completedAt: new Date() });
    await completeTutorialGate(asRole('MEMBER', 'm-7'), 'DOCUMENT_GRADING');

    const key = { userId: 'm-7', cycleId: CYCLE.id, category: 'DOCUMENT_GRADING' };
    expect(prisma.tutorialCompletion.upsert).toHaveBeenCalledWith({
      where: { userId_cycleId_category: key },
      update: {},
      create: key,
    });
  });

  it('records nothing when there is no current cycle', async () => {
    resolveCycleForRequest.mockResolvedValue(null);
    expect(await completeTutorialGate(asRole('MEMBER'), 'DOCUMENT_GRADING')).toBeNull();
    expect(prisma.tutorialCompletion.upsert).not.toHaveBeenCalled();
  });

  it('credits the cycle the popup was shown for, even if the current cycle moved since', async () => {
    // Shown in the fall cycle; an admin switched to winter before "Continue" was pressed.
    resolveCycleForRequest.mockResolvedValue({ id: 'cycle-winter' });
    prisma.recruitingCycle.findUnique.mockResolvedValue({ id: 'cycle-fall' });

    await completeTutorialGate(asRole('MEMBER', 'm-7'), 'DOCUMENT_GRADING', 'cycle-fall');

    expect(prisma.recruitingCycle.findUnique).toHaveBeenCalledWith({ where: { id: 'cycle-fall' }, select: { id: true } });
    expect(prisma.tutorialCompletion.upsert.mock.calls[0][0].create.cycleId).toBe('cycle-fall');
  });

  it('falls back to the current cycle when the shown cycle does not exist', async () => {
    prisma.recruitingCycle.findUnique.mockResolvedValue(null);
    await completeTutorialGate(asRole('MEMBER', 'm-7'), 'DOCUMENT_GRADING', 'no-such-cycle');
    expect(prisma.tutorialCompletion.upsert.mock.calls[0][0].create.cycleId).toBe(CYCLE.id);
  });
});
