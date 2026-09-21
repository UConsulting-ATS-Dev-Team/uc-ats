// The bank an interviewer browses has to be the bank of the cycle their interview belongs
// to. Scoping it to whichever cycle is active instead held only until recruitment moved
// on: after that, every interview still being run against the previous cycle got an empty
// list back, and the question bank looked broken from the inside of an interview. The
// active-cycle pointers also resolve differently for an admin and a member, so the two
// could be shown different banks for the same interview.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import memberRoutes from './member.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    interviewAssignment: { findFirst: vi.fn(), findMany: vi.fn() },
    interviewSlotAssignment: { findMany: vi.fn() },
    interview: { findUnique: vi.fn() },
    interviewQuestion: { findFirst: vi.fn(), findMany: vi.fn() },
    interviewSessionQuestion: { create: vi.fn(), findFirst: vi.fn() },
    recruitingCycle: { findFirst: vi.fn() }
  }
}));

vi.mock('../services/realtime.js', async (importOriginal) => ({
  ...(await importOriginal()),
  nudgeSessionQuestions: vi.fn()
}));

const member = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'm@uc.org' };
const admin = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'a@uc.org' };
const stranger = { id: 'member-2', role: 'MEMBER', isActive: true, email: 's@uc.org' };
const USERS = [member, admin, stranger];

const INTERVIEW = 'int-1';
// The interview is being run against last season's cycle; recruitment has since moved on.
const INTERVIEW_CYCLE = 'cycle-winter';

let server;
let port;

const request = (path, { user = member } = {}) =>
  fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Authorization: `Bearer ${jwt.sign({ userId: user.id }, process.env.JWT_SECRET)}` }
  });

const bankPath = `/api/member/interviews/${INTERVIEW}/question-bank`;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/member', memberRoutes);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
});

afterAll(() => new Promise((resolve) => server.close(resolve)));

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockImplementation(async ({ where }) =>
    USERS.find((u) => u.id === where.id) || null
  );
  // Staffed the current way: a slot assignment, no legacy InterviewAssignment row.
  prisma.interviewSlotAssignment.findMany.mockResolvedValue([{ interviewId: INTERVIEW }]);
  prisma.interviewAssignment.findMany.mockResolvedValue([]);
  prisma.interview.findUnique.mockResolvedValue({
    id: INTERVIEW,
    cycleId: INTERVIEW_CYCLE,
    description: null
  });
  prisma.interviewQuestion.findMany.mockResolvedValue([]);
  // Nothing here may consult the active cycle; a test that trips this is reading the
  // wrong pointer.
  prisma.recruitingCycle.findFirst.mockImplementation(() => {
    throw new Error('the bank must not resolve the active cycle');
  });
});

describe('the interview question bank', () => {
  it('reads the cycle off the interview, not off whichever cycle is active', async () => {
    const res = await request(bankPath);

    expect(res.status).toBe(200);
    expect(prisma.interviewQuestion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cycleId: INTERVIEW_CYCLE, status: 'PUBLISHED' }
      })
    );
  });

  it('shows an admin and a member the same bank for the same interview', async () => {
    await request(bankPath, { user: member });
    await request(bankPath, { user: admin });

    const cycles = prisma.interviewQuestion.findMany.mock.calls.map(([args]) => args.where.cycleId);
    expect(cycles).toEqual([INTERVIEW_CYCLE, INTERVIEW_CYCLE]);
  });

  it('narrows by round and category without widening the cycle', async () => {
    const res = await request(`${bankPath}?round=ROUND_ONE&category=Casing`);

    expect(res.status).toBe(200);
    expect(prisma.interviewQuestion.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { cycleId: INTERVIEW_CYCLE, status: 'PUBLISHED', round: 'ROUND_ONE', category: 'Casing' }
      })
    );
  });

  // The list a member opens their interview from is roster-aware, so this has to be too:
  // staffing moved to InterviewSlotAssignment, and checking only the legacy table meant a
  // slot-assigned interviewer could open the interview and then be refused the bank.
  it('lets in a member staffed through a slot assignment', async () => {
    const res = await request(bankPath, { user: member });

    expect(res.status).toBe(200);
    expect(prisma.interviewSlotAssignment.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ userId: member.id, removedAt: null })
      })
    );
  });

  it('lets in a member carried only by a legacy roster blob', async () => {
    prisma.interviewSlotAssignment.findMany.mockResolvedValue([]);
    prisma.interview.findUnique.mockResolvedValue({
      id: INTERVIEW,
      cycleId: INTERVIEW_CYCLE,
      description: JSON.stringify({ memberGroups: [{ id: 'g1', memberIds: [member.id] }] })
    });

    const res = await request(bankPath, { user: member });

    expect(res.status).toBe(200);
  });

  it('refuses someone who is on the interview by none of the three routes', async () => {
    prisma.interviewSlotAssignment.findMany.mockResolvedValue([]);
    prisma.interviewAssignment.findMany.mockResolvedValue([]);

    const res = await request(bankPath, { user: stranger });

    expect(res.status).toBe(403);
    expect(prisma.interviewQuestion.findMany).not.toHaveBeenCalled();
  });

  it('answers empty rather than guessing when the interview is gone', async () => {
    prisma.interview.findUnique.mockResolvedValue(null);

    // cycleId is not nullable, so a missing cycle means a missing interview. An admin
    // gets past the access check and still must not be handed another cycle's bank.
    const res = await request(bankPath, { user: admin });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(prisma.interviewQuestion.findMany).not.toHaveBeenCalled();
  });

  it('scopes the facets to the same cycle', async () => {
    const res = await request(`${bankPath}/facets`);

    expect(res.status).toBe(200);
    prisma.interviewQuestion.findMany.mock.calls.forEach(([args]) => {
      expect(args.where.cycleId).toBe(INTERVIEW_CYCLE);
    });
  });

  it('will not pull another cycle’s question in by id', async () => {
    prisma.interviewQuestion.findFirst.mockResolvedValue(null);

    const res = await fetch(
      `http://127.0.0.1:${port}/api/member/interviews/${INTERVIEW}/session-questions/bank`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${jwt.sign({ userId: member.id }, process.env.JWT_SECRET)}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ questionId: 'from-another-cycle' })
      }
    );

    expect(res.status).toBe(404);
    // The lookup is what has to be scoped: an id alone must not reach outside the cycle.
    expect(prisma.interviewQuestion.findFirst).toHaveBeenCalledWith({
      where: { id: 'from-another-cycle', status: 'PUBLISHED', cycleId: INTERVIEW_CYCLE }
    });
    expect(prisma.interviewSessionQuestion.create).not.toHaveBeenCalled();
  });
});
