import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import adminRoutes from './admin.js';
import { sendFinalRejectionEmail } from '../services/emailNotifications.js';
import {
  scheduleFeedbackRequest,
  getFeedbackJobs,
  reconcileFeedbackJob
} from '../services/feedbackScheduler.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      updateMany: vi.fn(),
    },
    recruitingCycle: { findFirst: vi.fn(), findMany: vi.fn() },
    application: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    $transaction: vi.fn((ops) => Promise.all(ops)),
  }
}));

vi.mock('../services/emailNotifications.js', () => ({
  sendFinalAcceptanceEmail: vi.fn(),
  sendFinalRejectionEmail: vi.fn(),
}));

vi.mock('../services/feedbackScheduler.js', () => ({
  scheduleFeedbackRequest: vi.fn(),
  cancelPendingFeedbackRequest: vi.fn(),
  handleApplicationStatusChange: vi.fn(),
  processFeedbackJobs: vi.fn(),
  getFeedbackJobs: vi.fn(),
  retryFeedbackJob: vi.fn(),
  reconcileFeedbackJob: vi.fn(),
}));

const adminUser = {
  id: 'admin-1',
  role: 'ADMIN',
  isActive: true,
  email: 'admin@example.com',
  fullName: 'Admin User',
  graduationClass: 'Spring 2025'
};

const memberUser = {
  id: 'member-1',
  role: 'MEMBER',
  isActive: true,
  email: 'member@example.com',
  fullName: 'Member User',
  graduationClass: null
};

function tokenFor(user) {
  return jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
}

describe('GET /api/admin/users', () => {
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
    prisma.user.findMany.mockResolvedValue([]);
    prisma.user.updateMany.mockResolvedValue({ count: 0 });
    prisma.recruitingCycle.findMany.mockResolvedValue([]);
  });

  async function get(token = tokenFor(adminUser), query = {}) {
    const qs = new URLSearchParams(query).toString();
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`http://localhost:${port}/api/admin/users${qs ? '?' + qs : ''}`, { headers });
  }

  it('returns users for an admin', async () => {
    prisma.user.findMany.mockResolvedValue([adminUser, memberUser]);

    const res = await get();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await get(null);
    expect(res.status).toBe(401);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('rejects non-admin requests', async () => {
    const res = await get(tokenFor(memberUser));
    expect(res.status).toBe(403);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('filters by role', async () => {
    await get(tokenFor(adminUser), { role: 'MEMBER' });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ role: 'MEMBER' })
      })
    );
  });

  it('maps INTERVIEWER role to MEMBER', async () => {
    await get(tokenFor(adminUser), { role: 'INTERVIEWER' });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ role: 'MEMBER' })
      })
    );
  });

  it('filters by graduation class', async () => {
    await get(tokenFor(adminUser), { graduationClass: 'Fall 2024' });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ graduationClass: 'Fall 2024' })
      })
    );
  });

  it('filters by missing graduation class using the sentinel value', async () => {
    await get(tokenFor(adminUser), { graduationClass: '__UNKNOWN_GRADUATION_CLASS__' });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { graduationClass: null },
            { graduationClass: '' }
          ]
        })
      })
    );
  });

  it('composes role and graduation class filters', async () => {
    await get(tokenFor(adminUser), { role: 'MEMBER', graduationClass: 'Spring 2025' });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          role: 'MEMBER',
          graduationClass: 'Spring 2025'
        })
      })
    );
  });

  it('composes role and missing graduation class filters', async () => {
    await get(tokenFor(adminUser), { role: 'MEMBER', graduationClass: '__UNKNOWN_GRADUATION_CLASS__' });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          role: 'MEMBER',
          OR: [
            { graduationClass: null },
            { graduationClass: '' }
          ]
        })
      })
    );
  });

  it('returns 400 for an invalid graduation class type', async () => {
    const res = await get(tokenFor(adminUser), 'graduationClass=bad&graduationClass=worse');
    expect(res.status).toBe(400);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('returns 400 for an excessively long graduation class', async () => {
    const longClass = 'a'.repeat(101);
    const res = await get(tokenFor(adminUser), { graduationClass: longClass });
    expect(res.status).toBe(400);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('ignores an empty graduation class query value', async () => {
    const res = await get(tokenFor(adminUser), { graduationClass: '' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  async function getClasses(token = tokenFor(adminUser), query = {}) {
    const qs = new URLSearchParams(query).toString();
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`http://localhost:${port}/api/admin/users/classes${qs ? '?' + qs : ''}`, { headers });
  }

  describe('GET /api/admin/users/classes', () => {
    it('returns class options and counts for an admin', async () => {
      prisma.user.findMany.mockResolvedValue([
        { graduationClass: 'Fall 2024' },
        { graduationClass: 'Fall 2024' },
        { graduationClass: 'Spring 2025' },
        { graduationClass: '' },
        { graduationClass: null },
        { graduationClass: '  ' }
      ]);

      const res = await getClasses();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(6);
      expect(body.classes).toEqual([
        { value: 'Fall 2024', label: 'Fall 2024', count: 2 },
        { value: 'Spring 2025', label: 'Spring 2025', count: 1 }
      ]);
      expect(body.unknown).toEqual({
        value: '__UNKNOWN_GRADUATION_CLASS__',
        label: 'Unknown / No class',
        count: 3
      });
    });

    it('rejects unauthenticated requests', async () => {
      const res = await getClasses(null);
      expect(res.status).toBe(401);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('rejects non-admin requests', async () => {
      const res = await getClasses(tokenFor(memberUser));
      expect(res.status).toBe(403);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('composes role filter but ignores the graduation class filter', async () => {
      prisma.user.findMany.mockResolvedValue([
        { role: 'MEMBER', graduationClass: 'Fall 2024' },
        { role: 'MEMBER', graduationClass: null }
      ]);

      const res = await getClasses(tokenFor(adminUser), { role: 'MEMBER', graduationClass: 'Fall 2024' });
      expect(res.status).toBe(200);
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ role: 'MEMBER' }),
          select: { graduationClass: true }
        })
      );
      const body = await res.json();
      expect(body.total).toBe(2);
      expect(body.classes).toHaveLength(1);
      expect(body.unknown.count).toBe(1);
    });
  });

  async function post(endpoint, body, token = tokenFor(adminUser)) {
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`http://localhost:${port}/api/admin${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body)
    });
  }

  function makeMember(overrides = {}) {
    const relations = {
      applications: [],
      comments: [],
      coverLetterScores: [],
      createdCases: [],
      createdInterviews: [],
      evaluations: [],
      firstRoundEvaluations: [],
      flaggedDocuments: [],
      groupMemberships: [],
      interviewAssignments: [],
      interviewEvaluations: [],
      interviewResources: [],
      memberEventRsvp: [],
      memberOneGroups: [],
      memberTwoGroups: [],
      memberThreeGroups: [],
      meetingSlots: [],
      resumeScores: [],
      resolvedDocuments: [],
      sentMessages: [],
      videoScores: [],
      conversationParticipants: [],
      completedActionItems: [],
      createdBehavioralQuestions: [],
      caseAssignments: []
    };
    return {
      id: 'member-1',
      fullName: 'Member User',
      email: 'member@example.com',
      role: 'MEMBER',
      isActive: true,
      graduationClass: 'Fall 2020',
      ...relations,
      ...overrides
    };
  }

  describe('POST /api/admin/users/deactivate-preview', () => {
    it('rejects unauthenticated requests', async () => {
      const res = await post('/users/deactivate-preview', { graduationClass: 'Fall 2020' }, null);
      expect(res.status).toBe(401);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('rejects non-admin requests', async () => {
      const res = await post('/users/deactivate-preview', { graduationClass: 'Fall 2020' }, tokenFor(memberUser));
      expect(res.status).toBe(403);
    });

    it('returns 400 for missing graduationClass', async () => {
      const res = await post('/users/deactivate-preview', {});
      expect(res.status).toBe(400);
    });

    it('returns 400 for a class without a graduation year', async () => {
      const res = await post('/users/deactivate-preview', { graduationClass: 'Unknown / No class' });
      expect(res.status).toBe(400);
    });

    it('returns eligible members whose deactivation date has passed', async () => {
      prisma.user.findMany.mockResolvedValue([makeMember({ id: 'm1', fullName: 'Old Member' })]);
      const res = await post('/users/deactivate-preview', { graduationClass: 'Fall 2020' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.eligibleCount).toBe(1);
      expect(body.totalFound).toBe(1);
    });

    it('marks future classes as ineligible', async () => {
      prisma.user.findMany.mockResolvedValue([makeMember({ id: 'm1', fullName: 'Future Member', graduationClass: 'Fall 2099' })]);
      const res = await post('/users/deactivate-preview', { graduationClass: 'Fall 2099' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.ineligibleCount).toBe(1);
    });

    it('blocks members with active-cycle relations', async () => {
      prisma.recruitingCycle.findMany.mockResolvedValue([{ id: 'cycle-1' }]);
      prisma.user.findMany.mockResolvedValue([makeMember({ id: 'm1', applications: [{ cycleId: 'cycle-1' }] })]);
      const res = await post('/users/deactivate-preview', { graduationClass: 'Fall 2020' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.blockedCount).toBe(1);
    });

    it('includes relation counts for eligible members', async () => {
      prisma.user.findMany.mockResolvedValue([
        makeMember({ id: 'm1', fullName: 'Old Member', applications: [{ cycleId: null }], resumeScores: [{}, {}] })
      ]);
      const res = await post('/users/deactivate-preview', { graduationClass: 'Fall 2020' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.eligible[0].relations.applications).toBe(1);
      expect(body.eligible[0].relations.scores).toBe(2);
    });
  });

  describe('POST /api/admin/users/deactivate', () => {
    it('rejects wrong confirmation text', async () => {
      prisma.user.findMany.mockResolvedValue([makeMember({ id: 'm1' })]);
      const res = await post('/users/deactivate', { graduationClass: 'Fall 2020', confirmationText: 'wrong', confirmedCount: 1, dryRun: false });
      expect(res.status).toBe(400);
    });

    it('rejects mismatched confirmedCount', async () => {
      prisma.user.findMany.mockResolvedValue([makeMember({ id: 'm1' })]);
      const res = await post('/users/deactivate', { graduationClass: 'Fall 2020', confirmationText: 'Fall 2020', confirmedCount: 99, dryRun: false });
      expect(res.status).toBe(400);
    });

    it('performs a dry run without updating users', async () => {
      prisma.user.findMany.mockResolvedValue([makeMember({ id: 'm1' })]);
      const res = await post('/users/deactivate', { graduationClass: 'Fall 2020', confirmationText: 'Fall 2020', confirmedCount: 1, dryRun: true });
      expect(res.status).toBe(200);
      expect(prisma.user.updateMany).not.toHaveBeenCalled();
    });

    it('deactivates eligible members on execution', async () => {
      prisma.user.findMany.mockResolvedValue([makeMember({ id: 'm1' })]);
      prisma.user.updateMany.mockResolvedValue({ count: 1 });
      const res = await post('/users/deactivate', { graduationClass: 'Fall 2020', confirmationText: 'Fall 2020', confirmedCount: 1, dryRun: false });
      expect(res.status).toBe(200);
      expect(prisma.user.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: { in: ['m1'] } },
          data: expect.objectContaining({ isActive: false })
        })
      );
    });
  });
});

describe('POST /api/admin/process-final-decisions', () => {
  let app;
  let server;
  let port;
  let mockApplications;

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

  function matchApplication(app, where = {}) {
    if (where.id && app.id !== where.id) return false;
    if (where.cycleId !== undefined && app.cycleId !== where.cycleId) return false;
    if (where.currentRound !== undefined && app.currentRound !== where.currentRound) return false;
    if (where.decisionSendStatus) {
      const status = app.decisionSendStatus ?? null;
      if (where.decisionSendStatus.in && !where.decisionSendStatus.in.includes(status)) return false;
      if (typeof where.decisionSendStatus === 'string' && status !== where.decisionSendStatus) return false;
    }
    if (where.decisionSendAttemptedAt?.lte !== undefined) {
      const ts = app.decisionSendAttemptedAt ? new Date(app.decisionSendAttemptedAt).getTime() : null;
      if (ts === null || ts > new Date(where.decisionSendAttemptedAt.lte).getTime()) return false;
    }
    if (where.OR && !where.OR.some((cond) => matchApplication(app, cond))) return false;
    return true;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockApplications = [];
    prisma.recruitingCycle.findFirst.mockResolvedValue({ id: 'cycle-1', name: 'Fall 2026', isActive: true });
    prisma.application.findMany.mockImplementation(({ where } = {}) => {
      return Promise.resolve(mockApplications.filter((a) => matchApplication(a, where)));
    });
    prisma.application.findUnique.mockImplementation(({ where: { id } }) => {
      const record = mockApplications.find((a) => a.id === id);
      return Promise.resolve(record ? { ...record } : null);
    });
    prisma.application.update = vi.fn(async ({ where: { id }, data }) => {
      const record = mockApplications.find((a) => a.id === id);
      if (record) Object.assign(record, data);
      return Promise.resolve(record ? { ...record } : null);
    });
    prisma.application.updateMany = vi.fn(async ({ where, data }) => {
      const record = mockApplications.find((a) => matchApplication(a, where));
      if (record) Object.assign(record, data);
      return Promise.resolve({ count: record ? 1 : 0 });
    });
  });

  function postProcessFinalDecisions() {
    return fetch(`http://localhost:${port}/api/admin/process-final-decisions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenFor(adminUser)}` },
    });
  }

  it('sends one rejection email and schedules one feedback job per application', async () => {
    sendFinalRejectionEmail.mockResolvedValue({ success: true, messageId: 'rejection-1' });
    scheduleFeedbackRequest.mockResolvedValue({ id: 'job-1' });

    mockApplications.push({
      id: 'app-1',
      email: 'jane@example.com',
      firstName: 'Jane',
      lastName: 'Doe',
      currentRound: '4',
      approved: false,
      cycleId: 'cycle-1',
      decisionSentAt: null,
      candidate: { id: 'cand-1' },
    });

    const first = await (await postProcessFinalDecisions()).json();
    expect(first.results.rejected).toHaveLength(1);
    expect(first.results.emailsSent).toBe(1);
    expect(sendFinalRejectionEmail).toHaveBeenCalledTimes(1);
    expect(scheduleFeedbackRequest).toHaveBeenCalledTimes(1);

    const second = await (await postProcessFinalDecisions()).json();
    expect(second.results.rejected).toHaveLength(1);
    expect(second.results.rejected[0].note).toBe('Decision email already sent');
    expect(sendFinalRejectionEmail).toHaveBeenCalledTimes(1);
    expect(scheduleFeedbackRequest).toHaveBeenCalledTimes(1);
  });

  it('sends only one rejection email for concurrent final-decision requests', async () => {
    sendFinalRejectionEmail.mockImplementation(
      () => new Promise((resolve) => setImmediate(() => resolve({ success: true, messageId: 'rejection-1' })))
    );
    scheduleFeedbackRequest.mockResolvedValue({ id: 'job-1' });

    mockApplications.push({
      id: 'app-1',
      email: 'jane@example.com',
      firstName: 'Jane',
      lastName: 'Doe',
      currentRound: '4',
      approved: false,
      cycleId: 'cycle-1',
      decisionSentAt: null,
      candidate: { id: 'cand-1' },
    });

    const [first, second] = await Promise.all([
      postProcessFinalDecisions().then((res) => res.json()),
      postProcessFinalDecisions().then((res) => res.json()),
    ]);

    expect(sendFinalRejectionEmail).toHaveBeenCalledTimes(1);
    expect(scheduleFeedbackRequest).toHaveBeenCalledTimes(1);
    expect(first.results.emailsSent + second.results.emailsSent).toBe(1);
    const app = mockApplications[0];
    expect(app.decisionSendStatus).toBe('SENT');
    expect(app.decisionSentAt).not.toBeNull();
  });

  it('reconciles provider-success -> SENT state-write failure without resending', async () => {
    sendFinalRejectionEmail.mockResolvedValue({ success: true, messageId: 'rejection-1' });
    scheduleFeedbackRequest.mockResolvedValue({ id: 'job-1' });

    mockApplications.push({
      id: 'app-1',
      email: 'jane@example.com',
      firstName: 'Jane',
      lastName: 'Doe',
      currentRound: '4',
      approved: false,
      cycleId: 'cycle-1',
      decisionSentAt: null,
      candidate: { id: 'cand-1' },
    });

    const originalUpdateMany = prisma.application.updateMany;
    prisma.application.updateMany = vi.fn(async ({ where, data }) => {
      if (data?.decisionSendStatus === 'SENT') {
        throw new Error('Simulated SENT state write failure');
      }
      return originalUpdateMany({ where, data });
    });

    const first = await (await postProcessFinalDecisions()).json();
    expect(first.results.emailsSent).toBe(1);
    expect(first.results.rejected[0].note).toMatch(/reconciliation pending/);
    expect(sendFinalRejectionEmail).toHaveBeenCalledTimes(1);
    expect(scheduleFeedbackRequest).toHaveBeenCalledTimes(0);
    const app = mockApplications[0];
    expect(app.decisionSendStatus).toBe('SENDING');
    expect(app.decisionSendMessageId).toBe('rejection-1');

    // Simulate lease expiry so the next run reconciles the SENDING record.
    app.decisionSendAttemptedAt = new Date('2026-07-27T10:00:00.000Z');
    prisma.application.updateMany = originalUpdateMany;

    const second = await (await postProcessFinalDecisions()).json();
    expect(second.results.rejected).toHaveLength(1);
    expect(second.results.rejected[0].note).toBe('Decision email already sent');
    expect(sendFinalRejectionEmail).toHaveBeenCalledTimes(1);
    expect(scheduleFeedbackRequest).toHaveBeenCalledTimes(1);
    expect(app.decisionSendStatus).toBe('SENT');
    expect(app.decisionSentAt).not.toBeNull();
  });

  it('marks provider-success -> message-id write failure as UNKNOWN and does not resend', async () => {
    sendFinalRejectionEmail.mockResolvedValue({ success: true, messageId: 'rejection-1' });
    scheduleFeedbackRequest.mockResolvedValue({ id: 'job-1' });

    mockApplications.push({
      id: 'app-1',
      email: 'jane@example.com',
      firstName: 'Jane',
      lastName: 'Doe',
      currentRound: '4',
      approved: false,
      cycleId: 'cycle-1',
      decisionSentAt: null,
      candidate: { id: 'cand-1' },
    });

    const originalUpdateMany = prisma.application.updateMany;
    prisma.application.updateMany = vi.fn(async ({ where, data }) => {
      if (data?.decisionSendMessageId && data?.decisionSentAt && !data?.decisionSendStatus) {
        throw new Error('Simulated provider result write failure');
      }
      return originalUpdateMany({ where, data });
    });

    const first = await (await postProcessFinalDecisions()).json();
    expect(first.results.emailsSent).toBe(1);
    expect(first.results.rejected[0].note).toMatch(/reconciliation pending/);
    expect(sendFinalRejectionEmail).toHaveBeenCalledTimes(1);
    expect(scheduleFeedbackRequest).toHaveBeenCalledTimes(0);
    const app = mockApplications[0];
    expect(app.decisionSendStatus).toBe('SENDING');
    expect(app.decisionSendMessageId).toBeNull();
    expect(app.decisionSentAt).toBeNull();

    // Simulate lease expiry so the next run reconciles the SENDING record.
    app.decisionSendAttemptedAt = new Date('2026-07-27T10:00:00.000Z');
    prisma.application.updateMany = originalUpdateMany;

    const second = await (await postProcessFinalDecisions()).json();
    expect(second.results.rejected).toHaveLength(1);
    expect(second.results.rejected[0].note).toBe('Decision email outcome unknown; requires operator reconciliation');
    expect(sendFinalRejectionEmail).toHaveBeenCalledTimes(1);
    expect(scheduleFeedbackRequest).toHaveBeenCalledTimes(0);
    expect(app.decisionSendStatus).toBe('UNKNOWN');
  });
});

describe('Admin feedback scheduler routes', () => {
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
    prisma.recruitingCycle.findFirst.mockResolvedValue({ id: 'cycle-1', name: 'Fall 2026', isActive: true });
  });

  it('GET /api/admin/feedback-jobs returns jobs from the service', async () => {
    getFeedbackJobs.mockResolvedValue({
      jobs: [{ id: 'job-1', status: 'SENT' }],
      total: 1,
      page: 1,
      limit: 50,
      totalPages: 1,
    });

    const res = await fetch(`http://localhost:${port}/api/admin/feedback-jobs`, {
      headers: { Authorization: `Bearer ${tokenFor(adminUser)}` },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.jobs).toHaveLength(1);
    expect(getFeedbackJobs).toHaveBeenCalledWith(expect.objectContaining({ page: 1, limit: 50 }));
  });

  it('POST /api/admin/feedback-jobs/:id/reconcile invokes the reconcile service', async () => {
    reconcileFeedbackJob.mockResolvedValue({ id: 'job-1', status: 'SENT' });

    const res = await fetch(`http://localhost:${port}/api/admin/feedback-jobs/job-1/reconcile`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${tokenFor(adminUser)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: 'SENT', messageId: 'msg-123' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.job.status).toBe('SENT');
    expect(reconcileFeedbackJob).toHaveBeenCalledWith('job-1', { status: 'SENT', messageId: 'msg-123', reason: undefined, actor: 'admin@example.com' });
  });
});
