import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import reviewTeamsRoutes from './reviewTeams.js';
import prisma from '../prismaClient.js';
import { sendReviewerReminder } from '../services/emailNotifications.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    recruitingCycle: { findFirst: vi.fn() },
    groups: { findUnique: vi.fn() },
    user: { findUnique: vi.fn() },
    resumeScore: { findMany: vi.fn() },
    coverLetterScore: { findMany: vi.fn() },
    videoScore: { findMany: vi.fn() },
  }
}));

vi.mock('../services/emailNotifications.js', () => ({
  sendReviewerReminder: vi.fn().mockResolvedValue({ success: true })
}));

const adminUser = { id: 'admin-1', role: 'ADMIN', email: 'admin@example.com', fullName: 'Admin User' };
const memberUser = { id: 'member-1', role: 'MEMBER', email: 'member@example.com', fullName: 'Member User' };
const reviewerUser = { id: 'reviewer-1', role: 'MEMBER', email: 'reviewer@example.com', fullName: 'Reviewer One' };

const activeCycle = { id: 'cycle-1', name: 'Fall 2026', isActive: true };

const baseGroup = {
  id: 'group-1',
  name: 'Team Alpha',
  cycleId: activeCycle.id,
  memberOne: 'reviewer-1',
  memberTwo: null,
  memberThree: null,
  assignedCandidates: [
    {
      id: 'candidate-1',
      applications: [{ resumeUrl: 'url', coverLetterUrl: 'url', videoUrl: 'url' }]
    }
  ]
};

function tokenFor(user) {
  return jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
}

function mockUserLookup() {
  prisma.user.findUnique.mockImplementation(({ where: { id } }) => {
    if (id === adminUser.id) return adminUser;
    if (id === memberUser.id) return memberUser;
    if (id === reviewerUser.id) return reviewerUser;
    return null;
  });
}

describe('POST /api/review-teams/:groupId/reviewers/:reviewerId/reminder', () => {
  let app;
  let server;
  let port;

  beforeAll(async () => {
    app = express();
    app.use(express.json());
    app.use('/api/review-teams', reviewTeamsRoutes);
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
    prisma.groups.findUnique.mockResolvedValue(baseGroup);
    prisma.resumeScore.findMany.mockResolvedValue([]);
    prisma.coverLetterScore.findMany.mockResolvedValue([]);
    prisma.videoScore.findMany.mockResolvedValue([]);
    sendReviewerReminder.mockResolvedValue({ success: true });
  });

  async function post(groupId, reviewerId, token) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`http://localhost:${port}/api/review-teams/${groupId}/reviewers/${reviewerId}/reminder`, {
      method: 'POST',
      headers
    });
  }

  it('returns 401 when no authentication token is provided', async () => {
    const res = await post('group-1', 'reviewer-1');
    expect(res.status).toBe(401);
  });

  it('returns 403 when the caller is not an admin', async () => {
    const res = await post('group-1', 'reviewer-1', tokenFor(memberUser));
    expect(res.status).toBe(403);
  });

  it('returns 400 when there is no active recruiting cycle', async () => {
    prisma.recruitingCycle.findFirst.mockResolvedValue(null);
    const res = await post('group-1', 'reviewer-1', tokenFor(adminUser));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/no active recruiting cycle/i);
  });

  it('returns 404 when the requested team is not in the active cycle', async () => {
    prisma.groups.findUnique.mockResolvedValue({ ...baseGroup, cycleId: 'different-cycle' });
    const res = await post('group-1', 'reviewer-1', tokenFor(adminUser));
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/not found in the active cycle/i);
  });

  it('returns 400 when the reviewer is not a member of the requested team', async () => {
    const res = await post('group-1', 'outsider-1', tokenFor(adminUser));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/not a member/i);
  });

  it('returns 400 when the reviewer has no valid email address', async () => {
    prisma.user.findUnique.mockImplementation(({ where: { id } }) => {
      if (id === reviewerUser.id) return { ...reviewerUser, email: null };
      return null;
    });
    const res = await post('group-1', 'reviewer-1', tokenFor(adminUser));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/valid email address/i);
  });

  it('sends a reminder and returns 200 for a valid admin request', async () => {
    const res = await post('group-1', 'reviewer-1', tokenFor(adminUser));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.message).toMatch(/sent successfully/i);

    expect(sendReviewerReminder).toHaveBeenCalledOnce();
    expect(sendReviewerReminder).toHaveBeenCalledWith(
      reviewerUser.email,
      reviewerUser.fullName,
      baseGroup.name,
      activeCycle.name,
      expect.objectContaining({
        completedTotal: 0,
        expectedTotal: 3,
        completionPercent: 0,
        gradingUrl: expect.stringContaining('/document-grading')
      })
    );
  });

  it('returns a 502 with retryable error when the mail provider fails', async () => {
    sendReviewerReminder.mockResolvedValue({ success: false, error: 'SES throttled' });
    const res = await post('group-1', 'reviewer-1', tokenFor(adminUser));
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/failed to send reminder email/i);
    expect(body.details).toBe('SES throttled');
  });
});
