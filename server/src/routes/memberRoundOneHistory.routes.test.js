// Round one history is scores-and-feedback content about a named applicant, so
// it sits behind the same seal as every other evaluation surface: a sealed
// candidate must answer 423 before a single question or note is read, not after.
// The other half of this file guards the empty case - a candidate with no round
// one on record has to come back as an ordinary empty result, because a 404 or a
// 500 there reads to the interviewer as "the panel is broken", not "there is
// nothing to show".
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import memberRoutes from './member.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    application: { findUnique: vi.fn() },
    candidate: { findMany: vi.fn() },
    firstRoundInterviewEvaluation: { findMany: vi.fn() },
    behavioralQuestion: { findMany: vi.fn() },
    interview: { findMany: vi.fn(), findUnique: vi.fn() },
    interviewSlotSignup: { findFirst: vi.fn() },
    interviewSlot: { findMany: vi.fn() }
  }
}));

const member = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'm@uc.org' };
const applicant = { id: 'user-9', role: 'USER', isActive: true, email: 'a@uc.org' };
const USERS = [member, applicant];

const APPLICATION = 'app-1';
const R1 = 'int-r1';
const path = `/api/member/applications/${APPLICATION}/round-one-history`;

let server;
let port;

const request = (target = path, { user = member } = {}) =>
  fetch(`http://127.0.0.1:${port}${target}`, {
    headers: { Authorization: `Bearer ${jwt.sign({ userId: user.id }, process.env.JWT_SECRET)}` }
  });

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
  // Not sealed unless a test says so.
  prisma.application.findUnique.mockResolvedValue({
    id: APPLICATION,
    candidateId: 'cand-1',
    studentId: '123',
    email: 'a@uc.org'
  });
  prisma.candidate.findMany.mockResolvedValue([]);

  prisma.firstRoundInterviewEvaluation.findMany.mockResolvedValue([]);
  prisma.behavioralQuestion.findMany.mockResolvedValue([]);
  prisma.interview.findMany.mockResolvedValue([]);
  prisma.interview.findUnique.mockResolvedValue({ description: null });
  prisma.interviewSlotSignup.findFirst.mockResolvedValue(null);
  prisma.interviewSlot.findMany.mockResolvedValue([]);
});

describe('GET /api/member/applications/:id/round-one-history', () => {
  it('answers 423 for a sealed candidate and reads no round one content', async () => {
    prisma.candidate.findMany.mockResolvedValue([
      { id: 'cand-1', studentId: '123', email: 'a@uc.org' }
    ]);

    const res = await request();
    const body = await res.json();

    expect(res.status).toBe(423);
    expect(body.code).toBe('RECORD_LOCKED');
    // The seal has to come first. If any of these ran, the guard was applied
    // after the read and the content had already left the database.
    expect(prisma.firstRoundInterviewEvaluation.findMany).not.toHaveBeenCalled();
    expect(prisma.behavioralQuestion.findMany).not.toHaveBeenCalled();
  });

  it('returns 200 and an empty list when the candidate has no round one on record', async () => {
    const res = await request();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ applicationId: APPLICATION, interviews: [] });
  });

  it('returns the round one questions and notes for an unsealed candidate', async () => {
    prisma.interview.findMany.mockResolvedValue([
      { id: R1, title: 'Round One', interviewType: 'ROUND_ONE', startDate: new Date('2026-03-01T00:00:00.000Z'), endDate: null }
    ]);
    prisma.interviewSlotSignup.findFirst.mockResolvedValue({
      slot: { id: 'grp-1', legacyGroupId: null }
    });
    prisma.behavioralQuestion.findMany.mockImplementation(async ({ where }) => {
      if (where.applicationId === null) {
        return [{ id: 'q1', questionText: 'Tell me about a conflict.', order: 0 }];
      }
      return [{ id: 'q2', questionText: 'Why this industry?', order: 0, interviewId: R1 }];
    });
    prisma.firstRoundInterviewEvaluation.findMany.mockResolvedValue([
      {
        id: 'e1',
        interviewId: R1,
        applicationId: APPLICATION,
        evaluatorId: 'u1',
        decision: 'YES',
        behavioralNotes: JSON.stringify({ q1: 'Named the conflict, owned their part.' }),
        marketSizingNotes: null,
        additionalNotes: 'Strong close.',
        updatedAt: new Date('2026-03-02T00:00:00.000Z'),
        evaluator: { id: 'u1', fullName: 'Dana', email: 'd@uc.org' }
      }
    ]);

    const res = await request();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.interviews[0].questions.map((q) => [q.text, q.scope])).toEqual([
      ['Tell me about a conflict.', 'SHARED'],
      ['Why this industry?', 'CANDIDATE']
    ]);
    expect(body.interviews[0].evaluators[0]).toMatchObject({
      evaluatorName: 'Dana',
      additionalNotes: 'Strong close.',
      notesByQuestionId: { q1: 'Named the conflict, owned their part.' }
    });
  });

  it('refuses an applicant, who must never read staff evaluation notes', async () => {
    const res = await request(path, { user: applicant });

    expect(res.status).toBe(403);
    expect(prisma.behavioralQuestion.findMany).not.toHaveBeenCalled();
  });
});
