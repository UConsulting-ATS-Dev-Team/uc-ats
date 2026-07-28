import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import reviewTeamsRoutes from './reviewTeams.js';
import prisma from '../prismaClient.js';
import { sendReviewerReminder } from '../services/emailNotifications.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    recruitingCycle: { findFirst: vi.fn() },
    groups: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
      create: vi.fn(),
      createMany: vi.fn(),
    },
    groupMember: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      count: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    resumeScore: { findMany: vi.fn() },
    coverLetterScore: { findMany: vi.fn() },
    videoScore: { findMany: vi.fn() },
    $transaction: vi.fn(),
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
  memberOneUser: reviewerUser,
  memberTwoUser: null,
  memberThreeUser: null,
  groupMembers: [],
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

function userFixture(id, role = 'MEMBER') {
  return { id, role, email: `${id}@example.com`, fullName: `User ${id}` };
}

function groupFixture(members = []) {
  const [m1, m2, m3, ...extra] = members;
  return {
    id: 'group-1',
    name: 'Team Alpha',
    cycleId: activeCycle.id,
    memberOne: m1?.id ?? null,
    memberTwo: m2?.id ?? null,
    memberThree: m3?.id ?? null,
    memberOneUser: m1 ?? null,
    memberTwoUser: m2 ?? null,
    memberThreeUser: m3 ?? null,
    groupMembers: extra.map(m => ({ userId: m.id, user: m })),
    assignedCandidates: []
  };
}

describe('review-teams routes', () => {
  let app;
  let server;
  let port;

  beforeAll(async () => {
    process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
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
    prisma.$transaction.mockImplementation((ops) => Promise.all(ops));
    prisma.groupMember.createMany.mockResolvedValue({ count: 0 });
    prisma.groupMember.deleteMany.mockResolvedValue({ count: 0 });
    prisma.groups.update.mockResolvedValue({});
    sendReviewerReminder.mockResolvedValue({ success: true });
  });

  async function put(groupId, body, token = tokenFor(adminUser)) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`http://localhost:${port}/api/review-teams/${groupId}/members`, {
      method: 'PUT',
      headers,
      body: JSON.stringify(body)
    });
  }

  async function del(groupId, memberId, token = tokenFor(adminUser)) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`http://localhost:${port}/api/review-teams/${groupId}/members/${memberId}`, {
      method: 'DELETE',
      headers
    });
  }

  describe('POST /api/review-teams/:groupId/reviewers/:reviewerId/reminder', () => {
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

  describe('PUT /api/review-teams/:groupId/members', () => {
    it('adds a fourth member to a full legacy team', async () => {
      const m1 = userFixture('m1');
      const m2 = userFixture('m2');
      const m3 = userFixture('m3');
      const m4 = userFixture('m4');
      const before = groupFixture([m1, m2, m3]);
      const after = groupFixture([m1, m2, m3, m4]);

      prisma.groups.findUnique.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
      prisma.user.findMany.mockResolvedValue([m4]);
      prisma.groupMember.createMany.mockResolvedValue({ count: 1 });

      const res = await put('group-1', { memberId: m4.id });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(4);
      expect(body.map(m => m.id)).toContain(m4.id);
      expect(prisma.groups.update).not.toHaveBeenCalled();
      expect(prisma.groupMember.createMany).toHaveBeenCalledOnce();
    });

    it('adds a fifth member when the team already has four members', async () => {
      const m1 = userFixture('m1');
      const m2 = userFixture('m2');
      const m3 = userFixture('m3');
      const m4 = userFixture('m4');
      const m5 = userFixture('m5');
      const before = groupFixture([m1, m2, m3, m4]);
      const after = groupFixture([m1, m2, m3, m4, m5]);

      prisma.groups.findUnique.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
      prisma.user.findMany.mockResolvedValue([m5]);
      prisma.groupMember.createMany.mockResolvedValue({ count: 1 });

      const res = await put('group-1', { memberId: m5.id });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(5);
      expect(body.map(m => m.id)).toContain(m5.id);
    });

    it('fills an empty legacy slot before creating a join-table record', async () => {
      const m1 = userFixture('m1');
      const m2 = userFixture('m2');
      const m4 = userFixture('m4');
      // Legacy slots m1 and m2 are filled; m3 is null, and m4 is in the join table.
      const before = {
        ...groupFixture([m1, m2]),
        groupMembers: [{ userId: m4.id, user: m4 }]
      };
      const m3 = userFixture('m3');
      const after = {
        ...groupFixture([m1, m2, m3]),
        groupMembers: [{ userId: m4.id, user: m4 }]
      };

      prisma.groups.findUnique.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
      prisma.user.findMany.mockResolvedValue([m3]);

      const res = await put('group-1', { memberId: m3.id });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(4);
      expect(prisma.groups.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'group-1' },
        data: { memberThree: m3.id }
      }));
      expect(prisma.groupMember.createMany).not.toHaveBeenCalled();
    });

    it('rejects a duplicate member without mutating the team', async () => {
      const m1 = userFixture('m1');
      const m2 = userFixture('m2');
      const before = groupFixture([m1, m2]);

      prisma.groups.findUnique.mockResolvedValue(before);
      prisma.user.findMany.mockResolvedValue([m1]);

      const res = await put('group-1', { memberId: m1.id });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/already on this team/i);
      expect(prisma.groups.update).not.toHaveBeenCalled();
      expect(prisma.groupMember.createMany).not.toHaveBeenCalled();
    });

    it('rejects an invalid or unauthorized user', async () => {
      const m1 = userFixture('m1');
      const before = groupFixture([m1]);
      const unknown = userFixture('unknown', 'USER');

      prisma.groups.findUnique.mockResolvedValue(before);
      prisma.user.findMany.mockResolvedValue([unknown]);

      const res = await put('group-1', { memberId: unknown.id });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toMatch(/invalid or unauthorized user/i);
      expect(prisma.groups.update).not.toHaveBeenCalled();
      expect(prisma.groupMember.createMany).not.toHaveBeenCalled();
    });

    it('rejects a request with no member id', async () => {
      const res = await put('group-1', {});
      expect(res.status).toBe(400);
    });
  });

  describe('DELETE /api/review-teams/:groupId/members/:memberId', () => {
    it('removes a legacy slot member', async () => {
      const m1 = userFixture('m1');
      const m2 = userFixture('m2');
      const m3 = userFixture('m3');
      const before = groupFixture([m1, m2, m3]);
      const after = groupFixture([m1, m3]);

      prisma.groups.findUnique.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
      prisma.groupMember.deleteMany.mockResolvedValue({ count: 0 });

      const res = await del('group-1', m2.id);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.map(m => m.id)).not.toContain(m2.id);
      expect(body.map(m => m.id)).toContain(m1.id);
      expect(body.map(m => m.id)).toContain(m3.id);
      expect(prisma.groups.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: 'group-1' },
        data: { memberTwo: null }
      }));
    });

    it('removes a join-table member', async () => {
      const m1 = userFixture('m1');
      const m2 = userFixture('m2');
      const m3 = userFixture('m3');
      const m4 = userFixture('m4');
      const before = groupFixture([m1, m2, m3, m4]);
      const after = groupFixture([m1, m2, m3]);

      prisma.groups.findUnique.mockResolvedValueOnce(before).mockResolvedValueOnce(after);
      prisma.groupMember.deleteMany.mockResolvedValue({ count: 1 });

      const res = await del('group-1', m4.id);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.map(m => m.id)).not.toContain(m4.id);
      expect(prisma.groups.update).not.toHaveBeenCalled();
      expect(prisma.groupMember.deleteMany).toHaveBeenCalledWith({ where: { groupId: 'group-1', userId: m4.id } });
    });

    it('returns 404 when the member is not on the team', async () => {
      const m1 = userFixture('m1');
      const before = groupFixture([m1]);

      prisma.groups.findUnique.mockResolvedValue(before);
      prisma.groupMember.deleteMany.mockResolvedValue({ count: 0 });

      const res = await del('group-1', 'not-a-member');
      expect(res.status).toBe(404);
      expect(prisma.groups.update).not.toHaveBeenCalled();
    });
  });
});
