// Saving an evaluation from the member and admin routes, through what actually reaches
// the database. Edit Evaluation on My Interviews sends only { decision, notes }; that
// must not erase the notes the interview page wrote, and first round's post-grading
// notes must land somewhere.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import memberRoutes from './member.js';
import adminRoutes from './admin.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    recruitingCycle: { findFirst: vi.fn() },
    candidate: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn() },
    application: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn() },
    interview: { findUnique: vi.fn() },
    interviewEvaluation: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
    firstRoundInterviewEvaluation: { findFirst: vi.fn(), findMany: vi.fn(), update: vi.fn(), create: vi.fn() },
  },
}));

const member = { id: 'm1', role: 'MEMBER', isActive: true, email: 'm@uc.org', fullName: 'Jordan Rivera' };
const admin = { id: 'a1', role: 'ADMIN', isActive: true, email: 'a@uc.org', fullName: 'Ryan K' };

let server;
let port;
const call = (user, method, path, body) =>
  fetch(`http://localhost:${port}/api${path}`, {
    method,
    headers: { Authorization: `Bearer ${jwt.sign({ userId: user.id }, process.env.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: body && JSON.stringify(body),
  });

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const app = express();
  app.use(express.json());
  app.use('/api/member', memberRoutes);
  app.use('/api/admin', adminRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

let actingAs = member;
beforeEach(() => {
  vi.clearAllMocks();
  actingAs = member;
  prisma.user.findUnique.mockImplementation(() => Promise.resolve(actingAs));
  prisma.recruitingCycle.findFirst.mockResolvedValue({ id: 'c1', isActive: true });
  prisma.candidate.findMany.mockResolvedValue([]);
  prisma.candidate.findUnique.mockResolvedValue(null);
  prisma.candidate.findFirst.mockResolvedValue(null);
  prisma.application.findUnique.mockResolvedValue({ id: 'app1', candidateId: 'cand1', email: 'x@g.ucla.edu', studentId: '1', candidate: { id: 'cand1', recordsLockedAt: null } });
  prisma.application.findFirst.mockResolvedValue(null);
  prisma.application.findMany.mockResolvedValue([]);
  prisma.interviewEvaluation.update.mockImplementation(({ data }) => Promise.resolve({ id: 'e1', ...data }));
  prisma.interviewEvaluation.create.mockImplementation(({ data }) => Promise.resolve({ id: 'e1', ...data }));
  prisma.firstRoundInterviewEvaluation.update.mockImplementation(({ data }) => Promise.resolve({ id: 'f1', ...data }));
  prisma.firstRoundInterviewEvaluation.create.mockImplementation(({ data }) => Promise.resolve({ id: 'f1', ...data }));
});

describe('a decision-only edit of a final round evaluation', () => {
  beforeEach(() => {
    prisma.interview.findUnique.mockResolvedValue({ id: 'iv-final', interviewType: 'FINAL_ROUND' });
    prisma.interviewEvaluation.findFirst.mockResolvedValue({ id: 'e1' });
  });

  it.each([
    ['member', () => member, '/member/evaluations', { interviewId: 'iv-final' }],
    ['admin', () => admin, '/admin/interviews/iv-final/evaluations', {}],
  ])('through the %s route keeps the case notes and checklist', async (_, who, path, extra) => {
    actingAs = who();
    const res = await call(actingAs, 'POST', path, { ...extra, applicationId: 'app1', decision: 'YES', notes: 'Advance' });

    expect(res.status).toBe(200);
    const { data } = prisma.interviewEvaluation.update.mock.calls[0][0];
    expect(data).toMatchObject({ decision: 'YES', notes: 'Advance' });
    expect(data).not.toHaveProperty('casingNotes');
    expect(data).not.toHaveProperty('candidateDetails');
    expect(data).not.toHaveProperty('behavioralNotes');
  });
});

describe('a first round evaluation', () => {
  beforeEach(() => {
    prisma.interview.findUnique.mockResolvedValue({ id: 'iv-r1', interviewType: 'ROUND_ONE' });
    prisma.firstRoundInterviewEvaluation.findFirst.mockResolvedValue({ id: 'f1' });
  });

  it("stores the page's post-grading notes", async () => {
    await call(member, 'POST', '/member/evaluations', {
      interviewId: 'iv-r1',
      applicationId: 'app1',
      decision: 'MAYBE_YES',
      notes: 'Sharp on market sizing',
      behavioralNotes: { q1: 'Good story' },
      behavioralLeadership: 4,
    });

    const { data } = prisma.firstRoundInterviewEvaluation.update.mock.calls[0][0];
    expect(data).toMatchObject({ additionalNotes: 'Sharp on market sizing', behavioralLeadership: 4 });
  });

  it('keeps the behavioral notes on a decision-only edit', async () => {
    await call(member, 'POST', '/member/evaluations', { interviewId: 'iv-r1', applicationId: 'app1', decision: 'NO', notes: 'Changed my mind' });

    const { data } = prisma.firstRoundInterviewEvaluation.update.mock.calls[0][0];
    expect(data).toMatchObject({ decision: 'NO', additionalNotes: 'Changed my mind' });
    expect(data).not.toHaveProperty('behavioralNotes');
  });

  it('reads the post-grading notes back as notes', async () => {
    prisma.firstRoundInterviewEvaluation.findMany.mockResolvedValue([
      { id: 'f1', interviewId: 'iv-r1', applicationId: 'app1', evaluatorId: 'm1', additionalNotes: 'Saved earlier', behavioralNotes: null, application: { id: 'app1', candidate: { id: 'cand1' } } },
    ]);

    const res = await call(member, 'GET', '/member/evaluations?interviewId=iv-r1');
    const [row] = await res.json();
    expect(row.notes).toBe('Saved earlier');
  });
});
