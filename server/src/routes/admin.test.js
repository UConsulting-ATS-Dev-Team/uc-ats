import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';
import adminRoutes from './admin.js';
import prisma from '../prismaClient.js';
import { sendFinalRejectionEmail } from '../services/emailNotifications.js';
import { scheduleFeedbackRequest } from '../services/feedbackScheduler.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    recruitingCycle: { findFirst: vi.fn() },
    application: { findMany: vi.fn(), update: vi.fn() },
  }
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req, res, next) => next(),
  requireAdmin: (req, res, next) => {
    req.user = { id: 'admin-1', role: 'ADMIN', email: 'admin@example.com', fullName: 'Admin' };
    next();
  },
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
}));

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

  beforeEach(() => {
    vi.clearAllMocks();
    mockApplications = [];
    prisma.recruitingCycle.findFirst.mockResolvedValue({ id: 'cycle-1', name: 'Fall 2026', isActive: true });
    prisma.application.findMany.mockImplementation(() => Promise.resolve(mockApplications));
    prisma.application.update.mockImplementation(({ where: { id }, data }) => {
      const record = mockApplications.find((a) => a.id === id);
      if (record) Object.assign(record, data);
      return Promise.resolve(record ? { ...record } : null);
    });
  });

  function postProcessFinalDecisions() {
    return fetch(`http://localhost:${port}/api/admin/process-final-decisions`, { method: 'POST' });
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
});
