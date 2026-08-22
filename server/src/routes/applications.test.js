import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import applicationsRoutes from './applications.js';
import prisma from '../prismaClient.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    recruitingCycle: { findFirst: vi.fn() },
    application: {
      count: vi.fn(),
      findMany: vi.fn(),
      groupBy: vi.fn(),
    },
    grade: { findMany: vi.fn() },
    candidate: { findMany: vi.fn() },
    groups: { findMany: vi.fn() },
    user: { findUnique: vi.fn() },
  }
}));

const adminUser = { id: 'admin-1', role: 'ADMIN', email: 'admin@example.com', fullName: 'Admin User' };
const activeCycle = { id: 'cycle-1', name: 'Fall 2026', isActive: true };

function tokenFor(user) {
  return jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
}

function mockUserLookup() {
  prisma.user.findUnique.mockImplementation(({ where: { id } }) => {
    if (id === adminUser.id) return adminUser;
    return null;
  });
}

describe('GET /api/applications', () => {
  let app;
  let server;
  let port;

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
    app = express();
    app.use(express.json());
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
    mockUserLookup();
    prisma.recruitingCycle.findFirst.mockResolvedValue(activeCycle);
    prisma.application.count.mockResolvedValue(1);
    prisma.grade.findMany.mockResolvedValue([]);
    prisma.application.groupBy.mockResolvedValue([]);
    prisma.candidate.findMany.mockResolvedValue([]);
    prisma.groups.findMany.mockResolvedValue([]);
  });

  async function get(token = tokenFor(adminUser)) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`http://localhost:${port}/api/applications`, { headers });
  }

  it('includes reviewTeam with members and profileImage in the response', async () => {
    const application = {
      id: 'app-1',
      responseID: 'response-1',
      status: 'SUBMITTED',
      submittedAt: new Date(),
      email: 'candidate@example.com',
      firstName: 'Candidate',
      lastName: 'One',
      studentId: '12345',
      phoneNumber: '555-5555',
      graduationYear: '2027',
      isTransferStudent: false,
      priorCollegeYears: null,
      cumulativeGpa: '3.85',
      majorGpa: null,
      major1: 'Computer Science',
      major2: null,
      gender: 'Other',
      isFirstGeneration: false,
      resumeUrl: 'https://example.com/resume.pdf',
      blindResumeUrl: null,
      headshotUrl: 'https://example.com/headshot.png',
      coverLetterUrl: null,
      videoUrl: null,
      rawResponses: {},
      approved: null,
      currentRound: null,
      resumeDecision: null,
      coffeeChatDecision: null,
      firstRoundDecision: null,
      finalRoundDecision: null,
      cycleId: activeCycle.id,
      candidateId: 'candidate-1',
      testFor: null,
    };

    const memberUser = {
      id: 'member-1',
      fullName: 'Alice Anderson',
      email: 'alice@example.com',
      profileImage: '/api/uploads/profile-images/alice.png',
    };

    const group = {
      id: 'group-1',
      name: 'Team Alpha',
      cycleId: activeCycle.id,
      memberOne: memberUser.id,
      memberOneUser: memberUser,
      memberTwo: null,
      memberTwoUser: null,
      memberThree: null,
      memberThreeUser: null,
      groupMembers: [],
    };

    prisma.application.findMany.mockResolvedValue([application]);
    prisma.candidate.findMany.mockResolvedValue([{ id: 'candidate-1', assignedGroupId: group.id }]);
    prisma.groups.findMany.mockResolvedValue([group]);

    const res = await get();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(body.data[0].reviewTeam).toEqual({
      id: group.id,
      name: group.name,
      members: [
        {
          id: memberUser.id,
          fullName: memberUser.fullName,
          email: memberUser.email,
          profileImage: memberUser.profileImage,
        },
      ],
    });
  });

  it('returns a null reviewTeam when the candidate has no assigned group', async () => {
    const application = {
      id: 'app-2',
      responseID: 'response-2',
      status: 'SUBMITTED',
      submittedAt: new Date(),
      email: 'candidate2@example.com',
      firstName: 'Candidate',
      lastName: 'Two',
      studentId: '67890',
      phoneNumber: '555-5555',
      graduationYear: '2028',
      isTransferStudent: false,
      priorCollegeYears: null,
      cumulativeGpa: '3.50',
      majorGpa: null,
      major1: 'Economics',
      major2: null,
      gender: 'Other',
      isFirstGeneration: false,
      resumeUrl: 'https://example.com/resume.pdf',
      blindResumeUrl: null,
      headshotUrl: 'https://example.com/headshot.png',
      coverLetterUrl: null,
      videoUrl: null,
      rawResponses: {},
      approved: null,
      currentRound: null,
      resumeDecision: null,
      coffeeChatDecision: null,
      firstRoundDecision: null,
      finalRoundDecision: null,
      cycleId: activeCycle.id,
      candidateId: 'candidate-2',
      testFor: null,
    };

    prisma.application.findMany.mockResolvedValue([application]);
    prisma.candidate.findMany.mockResolvedValue([{ id: 'candidate-2', assignedGroupId: null }]);

    const res = await get();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.data[0].reviewTeam).toBeNull();
  });
});
