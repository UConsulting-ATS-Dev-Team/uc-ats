// "Run a session" on /admin/interviews loads its candidates from this route, so
// it has to resolve the session ids against the interview in the URL.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import { resolveGroupIds } from '../services/interviewRoster.js';
import adminRoutes from './admin.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    recruitingCycle: { findFirst: vi.fn() },
    candidate: { findMany: vi.fn() },
    interview: { findUnique: vi.fn() },
    application: { findMany: vi.fn() }
  }
}));

vi.mock('../services/interviewRoster.js', async (importOriginal) => ({
  ...(await importOriginal()),
  resolveGroupIds: vi.fn()
}));

const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'a@uc.org', fullName: 'Admin' };

let server;
let port;

const getApplications = (interviewId, groupIds) =>
  fetch(`http://localhost:${port}/api/admin/interviews/${interviewId}/applications?groupIds=${groupIds}`, {
    headers: { Authorization: `Bearer ${jwt.sign({ userId: adminUser.id }, process.env.JWT_SECRET)}` }
  });

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const app = express();
  app.use(express.json());
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
  prisma.user.findUnique.mockResolvedValue(adminUser);
  prisma.recruitingCycle.findFirst.mockResolvedValue({ id: 'cycle-1', isActive: true });
  prisma.candidate.findMany.mockResolvedValue([]);
  prisma.interview.findUnique.mockResolvedValue({ id: 'int-1', interviewType: 'COFFEE_CHAT' });
});

describe('GET /api/admin/interviews/:id/applications', () => {
  it("resolves the sessions against the interview in the URL and returns their candidates", async () => {
    resolveGroupIds.mockResolvedValue(['app-1']);
    prisma.application.findMany.mockResolvedValue([
      { id: 'app-1', firstName: 'Joe', lastName: 'Bruin', major1: 'Economics', graduationYear: 2028, candidateId: 'cand-1' }
    ]);

    const res = await getApplications('int-1', 'slot-a,slot-b');

    expect(res.status).toBe(200);
    expect(resolveGroupIds).toHaveBeenCalledWith('int-1', ['slot-a', 'slot-b']);
    const body = await res.json();
    expect(body).toEqual([
      expect.objectContaining({ id: 'app-1', name: 'Joe Bruin', major: 'Economics', year: 2028 })
    ]);
  });
});
