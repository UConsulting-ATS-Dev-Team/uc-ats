import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import adminRoutes from './admin.js';
import prisma from '../prismaClient.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    recruitingCycle: {},
    interview: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    groups: {
      findUnique: vi.fn(),
    },
    $executeRaw: vi.fn(),
    $transaction: vi.fn(),
  }
}));

const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'admin@example.com', fullName: 'Admin User' };
const memberUser = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'member@example.com', fullName: 'Member User' };
const candidateUser = { id: 'candidate-1', role: 'USER', isActive: true, email: 'candidate@example.com', fullName: 'Candidate User' };

const cycleId = 'cycle-1';

const sourceGroup = {
  id: 'group-1',
  name: 'Team Alpha',
  cycleId,
  assignedCandidates: [
    {
      id: 'candidate-1',
      studentId: '12345',
      firstName: 'Alice',
      lastName: 'Anderson',
      email: 'alice@example.com',
      applications: [
        { id: 'app-1', firstName: 'Alice', lastName: 'Anderson', email: 'alice@example.com', studentId: '12345', submittedAt: new Date() }
      ]
    },
    {
      id: 'candidate-2',
      studentId: '67890',
      firstName: 'Bob',
      lastName: 'Baker',
      email: 'bob@example.com',
      applications: [
        { id: 'app-2', firstName: 'Bob', lastName: 'Baker', email: 'bob@example.com', studentId: '67890', submittedAt: new Date() }
      ]
    },
    {
      id: 'candidate-3',
      studentId: '11111',
      firstName: 'Carol',
      lastName: 'Chen',
      email: 'carol@example.com',
      applications: []
    }
  ]
};

function interviewFixture(description = JSON.stringify({ applicationGroups: [], memberGroups: [], groupAssignments: {} })) {
  return {
    id: 'iv-1',
    title: 'Coffee Chat',
    cycleId,
    description,
  };
}

function tokenFor(user) {
  return jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
}

describe('POST /api/admin/interviews/:id/copy-candidate-group-preview', () => {
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
      if (id === candidateUser.id) return candidateUser;
      return null;
    });

    prisma.interview.findUnique.mockResolvedValue(interviewFixture());
    prisma.groups.findUnique.mockResolvedValue(sourceGroup);

    // Make the transaction run against the same prisma mock so the route tests
    // the full service path without a real database.
    prisma.$transaction.mockImplementation(async (cb) => {
      const tx = {
        interview: prisma.interview,
        groups: prisma.groups,
        $executeRaw: prisma.$executeRaw,
      };
      return cb(tx);
    });

    prisma.interview.update.mockImplementation(({ where, data }) => {
      const updated = interviewFixture(data.description);
      return Promise.resolve(updated);
    });
  });

  async function post(endpoint, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`http://localhost:${port}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  it('returns a preview for an admin', async () => {
    const res = await post(
      '/api/admin/interviews/iv-1/copy-candidate-group-preview',
      { sourceGroupId: sourceGroup.id },
      tokenFor(adminUser)
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.additionCount).toBe(2);
    expect(json.duplicateCount).toBe(0);
    expect(json.skippedCount).toBe(1);
  });

  it('rejects an unauthenticated request', async () => {
    const res = await post(
      '/api/admin/interviews/iv-1/copy-candidate-group-preview',
      { sourceGroupId: sourceGroup.id }
    );
    expect(res.status).toBe(401);
  });

  it('rejects a member request', async () => {
    const res = await post(
      '/api/admin/interviews/iv-1/copy-candidate-group-preview',
      { sourceGroupId: sourceGroup.id },
      tokenFor(memberUser)
    );
    expect(res.status).toBe(403);
  });

  it('rejects a candidate request', async () => {
    const res = await post(
      '/api/admin/interviews/iv-1/copy-candidate-group-preview',
      { sourceGroupId: sourceGroup.id },
      tokenFor(candidateUser)
    );
    expect(res.status).toBe(403);
  });

  it('returns 409 when source group and interview are in different cycles', async () => {
    prisma.groups.findUnique.mockResolvedValue({ ...sourceGroup, cycleId: 'other-cycle' });

    const res = await post(
      '/api/admin/interviews/iv-1/copy-candidate-group-preview',
      { sourceGroupId: sourceGroup.id },
      tokenFor(adminUser)
    );
    expect(res.status).toBe(409);
  });
});

describe('POST /api/admin/interviews/:id/copy-candidate-group', () => {
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

    prisma.interview.findUnique.mockResolvedValue(interviewFixture());
    prisma.groups.findUnique.mockResolvedValue(sourceGroup);

    prisma.$transaction.mockImplementation(async (cb) => {
      const tx = {
        interview: prisma.interview,
        groups: prisma.groups,
        $executeRaw: prisma.$executeRaw,
      };
      return cb(tx);
    });

    prisma.interview.update.mockImplementation(({ where, data }) => {
      const updated = interviewFixture(data.description);
      return Promise.resolve(updated);
    });
  });

  async function post(endpoint, body, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`http://localhost:${port}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });
  }

  it('commits an add-only copy for an admin', async () => {
    const res = await post(
      '/api/admin/interviews/iv-1/copy-candidate-group',
      { sourceGroupId: sourceGroup.id },
      tokenFor(adminUser)
    );

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.additionCount).toBe(2);
    expect(json.duplicateCount).toBe(0);
    expect(json.skippedCount).toBe(1);
    expect(json.copiedByUserId).toBe(adminUser.id);

    const updateArgs = prisma.interview.update.mock.calls[0][0];
    const config = JSON.parse(updateArgs.data.description);
    expect(config.applicationGroups).toHaveLength(1);
    expect(config.applicationGroups[0].applicationIds).toEqual(['app-1', 'app-2']);
    expect(config.applicationGroups[0].copiedFromGroupId).toBe(sourceGroup.id);
    expect(config.applicationGroups[0].copiedByUserId).toBe(adminUser.id);
  });

  it('is idempotent when re-run against the same interview', async () => {
    // Seed the interview as if a previous copy already wrote app-1 and app-2.
    const existingConfig = {
      applicationGroups: [
        {
          id: 'existing-group',
          name: 'Existing',
          applicationIds: ['app-1', 'app-2'],
          copiedFromGroupId: sourceGroup.id,
          copiedByUserId: adminUser.id,
          copiedAt: new Date().toISOString(),
        }
      ],
      memberGroups: [],
      groupAssignments: {}
    };

    // First commit to an empty interview
    await post(
      '/api/admin/interviews/iv-1/copy-candidate-group',
      { sourceGroupId: sourceGroup.id },
      tokenFor(adminUser)
    );

    // Simulate persisted state by updating the findUnique result and update mock.
    const updatedDescription = JSON.stringify(existingConfig);
    prisma.interview.findUnique.mockResolvedValue(interviewFixture(updatedDescription));

    const res = await post(
      '/api/admin/interviews/iv-1/copy-candidate-group',
      { sourceGroupId: sourceGroup.id, destinationGroupId: 'existing-group' },
      tokenFor(adminUser)
    );

    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.additionCount).toBe(0);
    expect(json.duplicateCount).toBe(2);
    expect(json.skippedCount).toBe(1);
  });

  it('rejects replace mode', async () => {
    const res = await post(
      '/api/admin/interviews/iv-1/copy-candidate-group',
      { sourceGroupId: sourceGroup.id, mode: 'replace' },
      tokenFor(adminUser)
    );
    expect(res.status).toBe(400);
  });
});
