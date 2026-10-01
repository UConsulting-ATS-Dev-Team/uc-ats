// PATCH /interviews/:id/config sets an interview's shared behavioral questions. It used
// to also store any other payload over Interview.description, which is where older
// interviews keep their roster; on the member route that was open to any signed-in user.
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
    candidate: { findMany: vi.fn() },
    interview: { findUnique: vi.fn(), update: vi.fn() },
    interviewSlot: { findFirst: vi.fn(), findMany: vi.fn().mockResolvedValue([]) },
    interviewSlotAssignment: { findMany: vi.fn() },
    interviewAssignment: { findMany: vi.fn() },
    behavioralQuestion: { findMany: vi.fn(), create: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  },
}));

const users = {
  member: { id: 'm1', role: 'MEMBER', isActive: true, email: 'm@uc.org', fullName: 'Jordan Rivera' },
  admin: { id: 'a1', role: 'ADMIN', isActive: true, email: 'a@uc.org', fullName: 'Ryan K' },
  candidate: { id: 'u1', role: 'USER', isActive: true, email: 'c@g.ucla.edu', fullName: 'Taylor Kim' },
};
const ROSTER = JSON.stringify({ memberGroups: [{ id: 'mg1', memberIds: ['someone'] }], applicationGroups: [{ id: 'g1', applicationIds: ['app1'] }] });

let server;
let port;
let actingAs;
const patch = (path, body) =>
  fetch(`http://localhost:${port}/api${path}`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${jwt.sign({ userId: actingAs.id }, process.env.JWT_SECRET)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
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

beforeEach(() => {
  vi.clearAllMocks();
  actingAs = users.member;
  prisma.user.findUnique.mockImplementation(() => Promise.resolve(actingAs));
  prisma.recruitingCycle.findFirst.mockResolvedValue({ id: 'c1', isActive: true });
  prisma.candidate.findMany.mockResolvedValue([]);
  prisma.interview.findUnique.mockResolvedValue({ id: 'iv1', interviewType: 'FINAL_ROUND', description: ROSTER });
  prisma.interviewSlot.findFirst.mockResolvedValue(null);
  prisma.interviewSlotAssignment.findMany.mockResolvedValue([{ interviewId: 'iv1' }]);
  prisma.interviewAssignment.findMany.mockResolvedValue([]);
  prisma.behavioralQuestion.findMany.mockResolvedValue([]);
  prisma.behavioralQuestion.create.mockResolvedValue({});
  prisma.behavioralQuestion.deleteMany.mockResolvedValue({ count: 0 });
});

const questions = (extra = {}) => ({ type: 'behavioral_questions', config: { groupId: 'g1', questions: ['Why consulting?'], ...extra } });

describe('PATCH /api/member/interviews/:id/config', () => {
  it('saves the shared questions of an interview the member is on', async () => {
    const res = await patch('/member/interviews/iv1/config', questions({ behavioralQuestions: true }));
    expect(res.status).toBe(200);
    expect(prisma.behavioralQuestion.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ questionText: 'Why consulting?', groupId: 'g1' }) })
    );
    expect(prisma.interview.update).not.toHaveBeenCalled();
  });

  it('never writes the payload over Interview.description', async () => {
    const res = await patch('/member/interviews/iv1/config', { type: 'coffee_chat', config: { memberGroups: [] } });
    expect(res.status).toBe(400);
    expect(prisma.interview.update).not.toHaveBeenCalled();
  });

  it("refuses a member who is not on the interview", async () => {
    prisma.interviewSlotAssignment.findMany.mockResolvedValue([]);
    const res = await patch('/member/interviews/iv1/config', questions({ behavioralQuestions: true }));
    expect(res.status).toBe(403);
    expect(prisma.behavioralQuestion.create).not.toHaveBeenCalled();
  });

  it('refuses a candidate outright', async () => {
    actingAs = users.candidate;
    const res = await patch('/member/interviews/iv1/config', { type: 'x', config: {} });
    expect(res.status).toBe(403);
    expect(prisma.interview.update).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/admin/interviews/:id/config', () => {
  it('saves questions sent without the old behavioralQuestions flag, instead of overwriting the roster', async () => {
    // What the Interviews page's Questions dialog sent: the flag outside config.
    actingAs = users.admin;
    const res = await patch('/admin/interviews/iv1/config', { ...questions(), behavioralQuestions: true });
    expect(res.status).toBe(200);
    expect(prisma.behavioralQuestion.create).toHaveBeenCalled();
    expect(prisma.interview.update).not.toHaveBeenCalled();
  });
});
