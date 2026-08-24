import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import adminRoutes from './admin.js';

vi.mock('../prismaClient.js', () => {
  const client = {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    recruitingCycle: { findFirst: vi.fn(), findMany: vi.fn() },
    application: { findMany: vi.fn(), count: vi.fn() },
    resumeScore: { findMany: vi.fn() },
    coverLetterScore: { findMany: vi.fn() },
    videoScore: { findMany: vi.fn() },
    eventAttendance: { findMany: vi.fn() },
    meetingSignup: { findMany: vi.fn() },
    groups: { findMany: vi.fn(), findUnique: vi.fn() },
    interview: { findUnique: vi.fn(), update: vi.fn() },
    events: { findMany: vi.fn() },
    flaggedDocument: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  };
  // Interactive transactions hand the callback a client bound to the transaction; the
  // mock passes the same client so loaders and their version read share it.
  client.$transaction = vi.fn((arg, options) =>
    typeof arg === 'function' ? arg(client, options) : Promise.all(arg)
  );
  return { default: client };
});

const adminUser = {
  id: 'admin-1',
  role: 'ADMIN',
  isActive: true,
  email: 'admin@example.com',
  fullName: 'Admin User',
  graduationClass: 'Spring 2025',
};

const memberUser = {
  id: 'member-1',
  role: 'MEMBER',
  isActive: true,
  email: 'member@example.com',
  fullName: 'Member User',
  graduationClass: null,
};

function tokenFor(user) {
  return jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
}

describe('POST /api/admin/interviews/:id/copy-candidate-groups/*', () => {
  let app;
  let server;
  let port;

  beforeAll(async () => {
    app = express();
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
    prisma.user.findUnique.mockImplementation(({ where: { id } }) => {
      if (id === adminUser.id) return adminUser;
      if (id === memberUser.id) return memberUser;
      return null;
    });
  });

  function baseInterview() {
    return {
      id: 'interview-1',
      title: 'Coffee Chat 1',
      cycleId: 'cycle-1',
      description: JSON.stringify({ applicationGroups: [] }),
    };
  }

  function baseGroup() {
    return {
      id: 'group-1',
      name: 'Team A',
      cycleId: 'cycle-1',
      assignedCandidates: [
        {
          id: 'candidate-1',
          firstName: 'Alice',
          lastName: 'Anderson',
          studentId: '12345678',
          applications: [
            {
              id: 'app-1',
              email: 'alice@example.com',
              firstName: 'Alice',
              lastName: 'Anderson',
              studentId: '12345678',
              phoneNumber: '555-0001',
              graduationYear: '2026',
              cumulativeGpa: '3.50',
              major1: 'Computer Science',
              resumeUrl: 'https://example.com/resume.pdf',
              headshotUrl: 'https://example.com/headshot.jpg',
              cycleId: 'cycle-1',
              submittedAt: new Date('2026-01-01T00:00:00.000Z'),
            },
          ],
        },
      ],
    };
  }

  it('allows admin to preview a copy', async () => {
    prisma.interview.findUnique.mockResolvedValue(baseInterview());
    prisma.groups.findUnique.mockResolvedValue(baseGroup());

    const res = await fetch(`http://localhost:${port}/api/admin/interviews/interview-1/copy-candidate-groups/preview`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenFor(adminUser)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceGroupId: 'group-1', targetGroupId: null, mode: 'add' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.preview.additions).toHaveLength(1);
  });

  it('allows admin to commit a copy', async () => {
    prisma.interview.findUnique.mockResolvedValue(baseInterview());
    prisma.groups.findUnique.mockResolvedValue(baseGroup());
    prisma.interview.update.mockResolvedValue({ id: 'interview-1' });

    const res = await fetch(`http://localhost:${port}/api/admin/interviews/interview-1/copy-candidate-groups/commit`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenFor(adminUser)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceGroupId: 'group-1', targetGroupId: null, mode: 'add' }),
    });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.config.applicationGroups).toHaveLength(1);
    expect(body.config.copyAudits).toHaveLength(1);
    expect(body.audit.copiedBy).toBe(adminUser.id);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await fetch(`http://localhost:${port}/api/admin/interviews/interview-1/copy-candidate-groups/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceGroupId: 'group-1' }),
    });

    expect(res.status).toBe(401);
    expect(prisma.interview.findUnique).not.toHaveBeenCalled();
  });

  it('rejects non-admin requests', async () => {
    prisma.interview.findUnique.mockResolvedValue(baseInterview());

    const res = await fetch(`http://localhost:${port}/api/admin/interviews/interview-1/copy-candidate-groups/preview`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenFor(memberUser)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceGroupId: 'group-1' }),
    });

    expect(res.status).toBe(403);
    expect(prisma.interview.findUnique).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid mode', async () => {
    prisma.interview.findUnique.mockResolvedValue(baseInterview());
    prisma.groups.findUnique.mockResolvedValue(baseGroup());

    const res = await fetch(`http://localhost:${port}/api/admin/interviews/interview-1/copy-candidate-groups/preview`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenFor(adminUser)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceGroupId: 'group-1', mode: 'merge' }),
    });

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/add.*replace/);
  });
});
