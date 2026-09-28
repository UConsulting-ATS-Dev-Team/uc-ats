// GET /api/applications/:id - the application detail page's read. Admins and
// the applicant only: members used to be served any application here.
import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import applicationsRoutes from './applications.js';
import prisma from '../prismaClient.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    application: { findUnique: vi.fn(), findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  }
}));

// Sealed records are their own suite; here every application is unsealed.
vi.mock('../utils/lockedRecords.js', () => ({
  applicationParamGuard: (req, res, next) => next(),
  redactLockedApplications: (rows) => rows,
}));

const users = {
  admin: { id: 'admin-1', role: 'ADMIN', email: 'admin@example.com' },
  member: { id: 'member-1', role: 'MEMBER', email: 'member@example.com' },
  applicant: { id: 'user-1', role: 'USER', email: 'applicant@example.com', studentId: '123456789' },
  memberWhoApplied: { id: 'member-2', role: 'MEMBER', email: 'applicant@example.com' },
};

const application = {
  id: 'app-1',
  email: 'applicant@example.com',
  studentId: '123456789',
  candidateId: 'cand-1',
  candidate: { id: 'cand-1', studentId: '123456789', email: 'applicant@example.com' },
  comments: [{ id: 'c-1', content: 'reviewer note' }],
};

describe('GET /api/applications/:id', () => {
  let server;
  let port;

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    const app = express();
    app.use('/api/applications', applicationsRoutes);
    server = app.listen(0);
    await new Promise((resolve) => server.on('listening', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findUnique.mockImplementation(({ where: { id } }) =>
      Object.values(users).find((u) => u.id === id) ?? null);
    prisma.application.findUnique.mockResolvedValue(application);
    prisma.application.findMany.mockResolvedValue([]);
  });

  const get = (user) =>
    fetch(`http://localhost:${port}/api/applications/app-1`, {
      headers: { Authorization: `Bearer ${jwt.sign({ userId: user.id }, process.env.JWT_SECRET)}` },
    });

  it('serves an admin the application with reviewer comments', async () => {
    const res = await get(users.admin);
    expect(res.status).toBe(200);
    expect((await res.json()).comments).toHaveLength(1);
  });

  it("refuses a member someone else's application", async () => {
    const res = await get(users.member);
    expect(res.status).toBe(403);
  });

  it('serves the applicant their own application, without reviewer comments', async () => {
    const res = await get(users.applicant);
    expect(res.status).toBe(200);
    expect((await res.json()).comments).toEqual([]);
  });

  it('serves a member their own application, without reviewer comments', async () => {
    const res = await get(users.memberWhoApplied);
    expect(res.status).toBe(200);
    expect((await res.json()).comments).toEqual([]);
  });
});
