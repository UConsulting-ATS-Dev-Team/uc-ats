import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConfig = vi.hoisted(() => ({
  jwtSecret: 'test-secret',
  baseUrl: 'http://localhost:3001',
  bulkCampaignSendsEnabled: false,
}));

const mockSendEmail = vi.hoisted(() => ({
  fn: vi.fn().mockResolvedValue({ success: true, messageId: 'ses-1' }),
}));

const mockPrisma = vi.hoisted(() => ({
  subscriber: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  suppressedEmail: {
    findMany: vi.fn(),
    upsert: vi.fn(),
    deleteMany: vi.fn(),
  },
  consentEvent: {
    create: vi.fn(),
  },
  campaignTemplate: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
    delete: vi.fn(),
  },
  campaignAudience: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
    delete: vi.fn(),
  },
  campaignSend: {
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn(),
  },
  campaignSendLog: {
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
    findUnique: vi.fn(),
  },
  campaignSendLogResolution: {
    create: vi.fn(),
  },
  $queryRaw: vi.fn(),
  $transaction: vi.fn(),
}));

vi.mock('../config.js', () => ({
  default: mockConfig,
}));

vi.mock('../prismaClient.js', () => ({
  default: mockPrisma,
}));

vi.mock('../services/emailNotifications.js', () => ({
  sendEmail: (...args) => mockSendEmail.fn(...args),
}));

import {
  resolveAudience,
  previewAudience,
  previewCampaignSend,
  approveCampaignSend,
  sendCampaign,
  retryFailedCampaignSend,
  sendScheduledCampaigns,
  reconcileCampaignLogs,
  reconcileCampaignSendAggregates,
  resolveCampaignLog,
  updateCampaignSend,
  recordSuppression,
} from './campaigns.js';

function subscriberWithCandidate(overrides = {}) {
  return {
    id: 'sub-1',
    email: 'alice@example.com',
    firstName: 'Alice',
    lastName: 'Anderson',
    consented: true,
    candidate: {
      id: 'cand-1',
      firstName: 'Alice',
      lastName: 'Anderson',
      applications: [
        {
          currentRound: 'ROUND_ONE',
          status: 'ACCEPTED',
          cycle: { name: 'Fall 2026' },
        },
      ],
    },
    ...overrides,
  };
}

function buildApprovedSend(overrides = {}) {
  return {
    id: 'send-1',
    name: 'Test send',
    status: 'APPROVED',
    scheduledAt: null,
    sentBy: 'admin-1',
    templateName: 'Welcome',
    templateSubject: 'Hi {{name}}',
    templateBody: '<p>Hello {{name}}</p>',
    templateVersion: 2,
    recipientSnapshot: [
      {
        subscriberId: 'sub-1',
        candidateId: 'cand-1',
        email: 'alice@example.com',
        firstName: 'Alice',
        lastName: 'Anderson',
        cycle: 'Fall 2026',
        stage: 'ROUND_ONE',
        status: 'ACCEPTED',
      },
    ],
    ...overrides,
  };
}

describe('campaigns service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.bulkCampaignSendsEnabled = false;
    mockSendEmail.fn.mockResolvedValue({ success: true, messageId: 'ses-1' });
    mockPrisma.campaignSendLog.create.mockImplementation((args) => ({
      id: `log-${args?.data?.email || 'x'}`,
    }));
    mockPrisma.campaignSendLog.update.mockResolvedValue({});
    mockPrisma.campaignSendLog.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.campaignSendLogResolution.create.mockResolvedValue({ id: 'res-1' });
    mockPrisma.$transaction.mockImplementation((callbackOrOps) =>
      typeof callbackOrOps === 'function' ? callbackOrOps(mockPrisma) : Promise.all(callbackOrOps)
    );
  });

  describe('resolveAudience', () => {
    it('only returns consented, non-suppressed subscribers matching filters', async () => {
      mockPrisma.subscriber.findMany.mockResolvedValue([subscriberWithCandidate()]);
      mockPrisma.suppressedEmail.findMany.mockResolvedValue([]);

      const result = await resolveAudience({ statuses: ['ACCEPTED'], rounds: ['ROUND_ONE'] });

      expect(result).toHaveLength(1);
      expect(result[0].email).toBe('alice@example.com');
      expect(mockPrisma.subscriber.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            consented: true,
            candidate: expect.objectContaining({
              applications: expect.objectContaining({
                some: expect.objectContaining({
                  status: { in: ['ACCEPTED'] },
                  currentRound: { in: ['ROUND_ONE'] },
                }),
              }),
            }),
          }),
        })
      );
    });

    it('excludes suppressed emails', async () => {
      const sub = subscriberWithCandidate();
      mockPrisma.subscriber.findMany.mockResolvedValue([sub]);
      mockPrisma.suppressedEmail.findMany.mockResolvedValue([{ email: 'alice@example.com' }]);

      const result = await resolveAudience({});

      expect(result).toHaveLength(0);
    });

    it('does not infer consent from an application alone', async () => {
      mockPrisma.subscriber.findMany.mockResolvedValue([]);

      const result = await resolveAudience({ statuses: ['ACCEPTED'] });

      expect(result).toHaveLength(0);
    });
  });

  describe('previewAudience', () => {
    it('returns a count and sample of eligible recipients', async () => {
      mockPrisma.subscriber.findMany.mockResolvedValue([
        subscriberWithCandidate({ email: 'a@example.com' }),
        subscriberWithCandidate({ email: 'b@example.com' }),
      ]);
      mockPrisma.suppressedEmail.findMany.mockResolvedValue([]);

      const result = await previewAudience({});

      expect(result.count).toBe(2);
      expect(result.sample).toHaveLength(2);
    });
  });

  describe('approveCampaignSend', () => {
    it('stores an immutable rendered snapshot, fingerprint, and approval metadata', async () => {
      const send = {
        id: 'send-1',
        name: 'Test',
        status: 'PENDING_APPROVAL',
        scheduledAt: null,
        sentBy: 'admin-1',
        template: {
          id: 'tmpl-1',
          name: 'Welcome',
          subject: 'Hi {{name}}',
          body: '<p>Hello {{name}}</p>',
          version: 2,
        },
        audience: { id: 'aud-1', filters: { statuses: ['ACCEPTED'] } },
        cycle: { id: 'cycle-1', name: 'Fall 2026' },
      };
      mockPrisma.campaignSend.findUnique.mockResolvedValue(send);
      mockPrisma.subscriber.findMany.mockResolvedValue([subscriberWithCandidate()]);
      mockPrisma.suppressedEmail.findMany.mockResolvedValue([]);
      mockPrisma.campaignSend.update.mockResolvedValue({ ...send, status: 'APPROVED' });

      const previewFingerprint = '7b8820b5b94d1c542ad06266921cad5be22ed6bb1ec4d2487cd44bc27e9224d4';
      await approveCampaignSend({ sendId: 'send-1', actorId: 'admin-1', approvalFingerprint: previewFingerprint });

      expect(mockPrisma.campaignSend.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'send-1' },
          data: expect.objectContaining({
            status: 'APPROVED',
            approvedBy: 'admin-1',
            approvalFingerprint: expect.any(String),
            templateVersion: 2,
            templateName: 'Welcome',
            templateSubject: 'Hi {{name}}',
            templateBody: '<p>Hello {{name}}</p>',
            audienceFilters: { statuses: ['ACCEPTED'] },
            recipientSnapshot: expect.arrayContaining([
              expect.objectContaining({ email: 'alice@example.com' }),
            ]),
            renderedPreview: expect.stringContaining('Hello Alice'),
            eligibilityBasis: expect.stringContaining('subscriber_consent'),
            previewCount: 1,
          }),
        })
      );
    });

    it('sets status to SCHEDULED when the send is scheduled for the future', async () => {
      const future = new Date(Date.now() + 3600000);
      const send = {
        id: 'send-1',
        status: 'PENDING_APPROVAL',
        scheduledAt: future,
        sentBy: 'admin-1',
        template: { name: 'T', subject: 'S', body: 'B', version: 1 },
        audience: { id: 'aud-1', filters: {} },
        cycle: null,
      };
      mockPrisma.campaignSend.findUnique.mockResolvedValue(send);
      mockPrisma.subscriber.findMany.mockResolvedValue([]);
      mockPrisma.suppressedEmail.findMany.mockResolvedValue([]);
      mockPrisma.campaignSend.update.mockResolvedValue({ ...send, status: 'SCHEDULED' });

      const previewFingerprint = 'dd0590dda8cd56aff20a017ed737b7a7da867df6eaf1e8c421000642a49d0f20';
      await approveCampaignSend({ sendId: 'send-1', actorId: 'admin-1', approvalFingerprint: previewFingerprint });

      expect(mockPrisma.campaignSend.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'SCHEDULED' }),
        })
      );
    });

    it('rejects approval of a send that is already sent', async () => {
      mockPrisma.campaignSend.findUnique.mockResolvedValue({
        id: 'send-1',
        status: 'SENT',
        template: { name: 'T', subject: 'S', body: 'B', version: 1 },
        audience: { id: 'aud-1', filters: {} },
      });

      await expect(approveCampaignSend({ sendId: 'send-1', actorId: 'admin-1', approvalFingerprint: 'fp' })).rejects.toThrow(/cannot be approved/i);
    });

    it('rejects stale approval when the preview no longer matches', async () => {
      const send = {
        id: 'send-1',
        name: 'Test',
        status: 'PENDING_APPROVAL',
        scheduledAt: null,
        sentBy: 'admin-1',
        template: {
          id: 'tmpl-1',
          name: 'Welcome',
          subject: 'Hi {{name}}',
          body: '<p>Hello {{name}}</p>',
          version: 2,
        },
        audience: { id: 'aud-1', filters: { statuses: ['ACCEPTED'] } },
        cycle: { id: 'cycle-1', name: 'Fall 2026' },
      };
      mockPrisma.campaignSend.findUnique.mockResolvedValue(send);
      // After the preview, Bob was added to the audience.
      mockPrisma.subscriber.findMany.mockResolvedValue([
        subscriberWithCandidate(),
        subscriberWithCandidate({ email: 'bob@example.com' }),
      ]);
      mockPrisma.suppressedEmail.findMany.mockResolvedValue([]);

      const oldPreviewFingerprint = 'stale-fingerprint-7b8820b5b94d1c542ad06266921cad5be22ed6bb1ec4d2487cd44bc27e9224d4';
      await expect(approveCampaignSend({ sendId: 'send-1', actorId: 'admin-1', approvalFingerprint: oldPreviewFingerprint })).rejects.toThrow(/stale/i);
    });

    it('rejects approval when a merge value or rendered content changes after preview', async () => {
      const send = {
        id: 'send-1',
        name: 'Test',
        status: 'PENDING_APPROVAL',
        scheduledAt: null,
        sentBy: 'admin-1',
        template: {
          id: 'tmpl-1',
          name: 'Welcome',
          subject: 'Hi {{name}}',
          body: '<p>Hello {{name}}</p>',
          version: 2,
        },
        audience: { id: 'aud-1', filters: { statuses: ['ACCEPTED'] } },
        cycle: { id: 'cycle-1', name: 'Fall 2026' },
      };
      mockPrisma.campaignSend.findUnique.mockResolvedValue(send);
      mockPrisma.subscriber.findMany.mockResolvedValue([subscriberWithCandidate()]);
      mockPrisma.suppressedEmail.findMany.mockResolvedValue([]);

      const preview = await previewCampaignSend({ sendId: 'send-1' });

      // The candidate name changes after preview; the rendered body and the
      // per-recipient merge snapshot are now different, so approval must fail.
      mockPrisma.subscriber.findMany.mockResolvedValue([
        subscriberWithCandidate({ firstName: 'Alicia' }),
      ]);

      await expect(
        approveCampaignSend({ sendId: 'send-1', actorId: 'admin-1', approvalFingerprint: preview.approvalFingerprint })
      ).rejects.toThrow(/stale/i);
    });
  });

  describe('updateCampaignSend', () => {
    it('blocks edits after the send has reached a terminal state', async () => {
      mockPrisma.campaignSend.findUnique.mockResolvedValue({ id: 'send-1', status: 'SENT' });

      await expect(updateCampaignSend('send-1', { name: 'New name' })).rejects.toThrow(/Cannot modify/i);
    });

    it('invalidates approval when the scheduled time is changed', async () => {
      const future = new Date(Date.now() + 3600000);
      mockPrisma.campaignSend.findUnique.mockResolvedValue({
        id: 'send-1',
        status: 'APPROVED',
        scheduledAt: new Date(),
      });
      mockPrisma.campaignSend.update.mockResolvedValue({});

      await updateCampaignSend('send-1', { scheduledAt: future });

      expect(mockPrisma.campaignSend.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'PENDING_APPROVAL',
            approvedBy: null,
            approvedAt: null,
            approvalFingerprint: null,
          }),
        })
      );
    });
  });

  describe('sendCampaign', () => {
    it('rejects live sends when the bulk send policy gate is disabled', async () => {
      mockPrisma.campaignSend.findUnique.mockResolvedValue(buildApprovedSend());

      await expect(sendCampaign('send-1', 'admin-1')).rejects.toThrow(/disabled until policy decisions/i);
    });

    it('requires approval before sending', async () => {
      mockConfig.bulkCampaignSendsEnabled = true;
      mockPrisma.campaignSend.findUnique.mockResolvedValue({
        id: 'send-1',
        status: 'PENDING_APPROVAL',
      });

      await expect(sendCampaign('send-1', 'admin-1')).rejects.toThrow(/approved/i);
    });

    it('sends to each approved recipient, logs one attempt, and marks the send sent', async () => {
      mockConfig.bulkCampaignSendsEnabled = true;
      const send = buildApprovedSend();
      mockPrisma.campaignSend.findUnique.mockResolvedValue(send);
      mockPrisma.campaignSend.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.campaignSend.update.mockResolvedValue({});
      mockPrisma.subscriber.findUnique.mockResolvedValue({ id: 'sub-1', email: 'alice@example.com', consented: true });
      mockPrisma.suppressedEmail.findMany.mockResolvedValue([]);

      const result = await sendCampaign('send-1', 'admin-1');

      expect(result.sent).toBe(1);
      expect(result.failed).toBe(0);
      expect(mockSendEmail.fn).toHaveBeenCalledTimes(1);
      expect(mockPrisma.campaignSendLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'PENDING',
            email: 'alice@example.com',
            attemptNumber: 1,
            renderedBody: expect.stringContaining('Hello Alice'),
          }),
        })
      );
      expect(mockPrisma.campaignSendLog.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'SENT', providerMessageId: 'ses-1' }),
        })
      );
      expect(mockPrisma.campaignSend.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'SENT', recipientCount: 1 }),
        })
      );
    });

    it('skips recipients that are suppressed at execution time', async () => {
      mockConfig.bulkCampaignSendsEnabled = true;
      const send = buildApprovedSend();
      mockPrisma.campaignSend.findUnique.mockResolvedValue(send);
      mockPrisma.campaignSend.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.campaignSend.update.mockResolvedValue({});
      mockPrisma.suppressedEmail.findMany.mockResolvedValue([{ email: 'alice@example.com' }]);

      const result = await sendCampaign('send-1', 'admin-1');

      expect(mockSendEmail.fn).not.toHaveBeenCalled();
      expect(result.sent).toBe(0);
    });

    it('skips recipients that have lost consent at execution time', async () => {
      mockConfig.bulkCampaignSendsEnabled = true;
      const send = buildApprovedSend();
      mockPrisma.campaignSend.findUnique.mockResolvedValue(send);
      mockPrisma.campaignSend.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.campaignSend.update.mockResolvedValue({});
      mockPrisma.suppressedEmail.findMany.mockResolvedValue([]);
      mockPrisma.subscriber.findUnique.mockResolvedValue({ id: 'sub-1', email: 'alice@example.com', consented: false });

      const result = await sendCampaign('send-1', 'admin-1');

      expect(mockSendEmail.fn).not.toHaveBeenCalled();
      expect(result.sent).toBe(0);
    });

    it('records partial success and marks the send as PARTIAL when some emails fail', async () => {
      mockConfig.bulkCampaignSendsEnabled = true;
      const send = buildApprovedSend({
        recipientSnapshot: [
          { subscriberId: 'sub-1', candidateId: 'cand-1', email: 'alice@example.com', firstName: 'Alice', lastName: 'Anderson' },
          { subscriberId: 'sub-2', candidateId: 'cand-2', email: 'bob@example.com', firstName: 'Bob', lastName: 'Barker' },
        ],
      });
      mockPrisma.campaignSend.findUnique.mockResolvedValue(send);
      mockPrisma.campaignSend.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.campaignSend.update.mockResolvedValue({});
      mockPrisma.suppressedEmail.findMany.mockResolvedValue([]);
      mockPrisma.subscriber.findUnique
        .mockResolvedValueOnce({ id: 'sub-1', email: 'alice@example.com', consented: true })
        .mockResolvedValueOnce({ id: 'sub-2', email: 'bob@example.com', consented: true });
      mockSendEmail.fn
        .mockResolvedValueOnce({ success: true, messageId: 'ses-1' })
        .mockResolvedValueOnce({ success: false, error: 'Bounce' });

      const result = await sendCampaign('send-1', 'admin-1');

      expect(result.sent).toBe(1);
      expect(result.failed).toBe(1);
      expect(mockPrisma.campaignSend.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'PARTIAL', recipientCount: 1, failedRecipientCount: 1 }),
        })
      );
    });

    it('marks the send FAILED when all recipients fail', async () => {
      mockConfig.bulkCampaignSendsEnabled = true;
      const send = buildApprovedSend();
      mockPrisma.campaignSend.findUnique.mockResolvedValue(send);
      mockPrisma.campaignSend.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.campaignSend.update.mockResolvedValue({});
      mockPrisma.suppressedEmail.findMany.mockResolvedValue([]);
      mockPrisma.subscriber.findUnique.mockResolvedValue({ id: 'sub-1', email: 'alice@example.com', consented: true });
      mockSendEmail.fn.mockResolvedValue({ success: false, error: 'SES failure' });

      const result = await sendCampaign('send-1', 'admin-1');

      expect(result.sent).toBe(0);
      expect(result.failed).toBe(1);
      expect(mockPrisma.campaignSend.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'FAILED' }),
        })
      );
    });

    it('prevents duplicate delivery attempts with a per-recipient idempotency claim', async () => {
      mockConfig.bulkCampaignSendsEnabled = true;
      const send = buildApprovedSend();
      mockPrisma.campaignSend.findUnique.mockResolvedValue(send);
      mockPrisma.campaignSend.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.campaignSend.update.mockResolvedValue({});
      mockPrisma.suppressedEmail.findMany.mockResolvedValue([]);
      mockPrisma.subscriber.findUnique.mockResolvedValue({ id: 'sub-1', email: 'alice@example.com', consented: true });
      mockPrisma.campaignSendLog.create
        .mockResolvedValueOnce({ id: 'log-1' })
        .mockRejectedValueOnce({ code: 'P2002', message: 'Unique constraint' });

      const result = await sendCampaign('send-1', 'admin-1');

      expect(mockSendEmail.fn).toHaveBeenCalledTimes(1);
      expect(result.sent).toBe(1);
    });

    it('is idempotent across repeated calls for the same send', async () => {
      mockConfig.bulkCampaignSendsEnabled = true;
      const send = buildApprovedSend();
      mockPrisma.campaignSend.findUnique.mockResolvedValue(send);
      mockPrisma.campaignSend.updateMany.mockResolvedValue({ count: 1 });

      const result = await sendCampaign('send-1', 'admin-1');
      expect(result).toBeDefined();

      // Second call without force should fail because status is SENT.
      mockPrisma.campaignSend.findUnique.mockResolvedValue({ ...send, status: 'SENT' });
      await expect(sendCampaign('send-1', 'admin-1')).rejects.toThrow(/already sent/i);
    });

    it('does not mark the send SENT while any recipient outcome is AMBIGUOUS', async () => {
      mockConfig.bulkCampaignSendsEnabled = true;
      const send = buildApprovedSend();
      mockPrisma.campaignSend.findUnique.mockResolvedValue(send);
      mockPrisma.campaignSend.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.campaignSend.update.mockResolvedValue({});
      mockPrisma.suppressedEmail.findMany.mockResolvedValue([]);
      mockPrisma.subscriber.findUnique.mockResolvedValue({ id: 'sub-1', email: 'alice@example.com', consented: true });
      mockPrisma.campaignSendLog.update
        .mockRejectedValueOnce(new Error('write failed'))
        .mockResolvedValueOnce({});

      const result = await sendCampaign('send-1', 'admin-1');

      expect(result.ambiguous).toBe(1);
      expect(mockPrisma.campaignSend.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'SENDING' }),
        })
      );
    });
  });

  describe('retryFailedCampaignSend', () => {
    it('retries failed logs with a new attempt number', async () => {
      mockConfig.bulkCampaignSendsEnabled = true;
      const send = buildApprovedSend({ status: 'SENT' });
      mockPrisma.campaignSend.findUnique.mockResolvedValue(send);
      mockPrisma.campaignSend.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.campaignSendLog.findMany.mockResolvedValue([
        { id: 'l1', email: 'alice@example.com', attemptNumber: 1, status: 'FAILED', candidateId: 'cand-1' },
      ]);
      mockPrisma.$queryRaw.mockResolvedValue([{ max: '1' }]);
      mockPrisma.suppressedEmail.findMany.mockResolvedValue([]);
      mockPrisma.subscriber.findUnique.mockResolvedValue({ id: 'sub-1', email: 'alice@example.com', consented: true });
      mockPrisma.campaignSendLog.count.mockResolvedValue(0);
      mockPrisma.campaignSend.update.mockResolvedValue({});

      const result = await retryFailedCampaignSend('send-1', 'admin-1');

      expect(result.retried).toBe(1);
      expect(result.sent).toBe(1);
      expect(mockPrisma.campaignSendLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ attemptNumber: 2 }),
        })
      );
    });
  });

  describe('sendScheduledCampaigns', () => {
    it('does not dispatch scheduled sends when the policy gate is disabled', async () => {
      mockConfig.bulkCampaignSendsEnabled = false;

      const results = await sendScheduledCampaigns();

      expect(results).toEqual([]);
      expect(mockPrisma.campaignSend.findMany).not.toHaveBeenCalled();
    });
  });

  describe('retryFailedCampaignSend', () => {
    it('does not retry a recipient whose latest attempt already succeeded', async () => {
      mockConfig.bulkCampaignSendsEnabled = true;
      const send = buildApprovedSend({ status: 'SENT' });
      mockPrisma.campaignSend.findUnique.mockResolvedValue(send);
      mockPrisma.campaignSend.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.campaignSendLog.findMany.mockResolvedValue([
        { id: 'l1', email: 'alice@example.com', attemptNumber: 1, status: 'FAILED', candidateId: 'cand-1' },
        { id: 'l2', email: 'alice@example.com', attemptNumber: 2, status: 'SENT', candidateId: 'cand-1' },
      ]);
      mockPrisma.$queryRaw.mockResolvedValue([{ max: '2' }]);
      mockPrisma.suppressedEmail.findMany.mockResolvedValue([]);
      mockPrisma.subscriber.findUnique.mockResolvedValue({ id: 'sub-1', email: 'alice@example.com', consented: true });
      mockPrisma.campaignSendLog.count.mockResolvedValue(0);
      mockPrisma.campaignSend.update.mockResolvedValue({});

      const result = await retryFailedCampaignSend('send-1', 'admin-1');

      expect(result.retried).toBe(0);
      expect(mockSendEmail.fn).not.toHaveBeenCalled();
      expect(mockPrisma.campaignSend.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'SENT' }) })
      );
    });

    it('retries a failed recipient and keeps the send FAILED when the new attempt also fails', async () => {
      mockConfig.bulkCampaignSendsEnabled = true;
      const send = buildApprovedSend({ status: 'FAILED' });
      mockPrisma.campaignSend.findUnique.mockResolvedValue(send);
      mockPrisma.campaignSend.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.campaignSendLog.findMany.mockResolvedValue([
        { id: 'l1', email: 'alice@example.com', attemptNumber: 1, status: 'FAILED', candidateId: 'cand-1' },
        { id: 'l2', email: 'alice@example.com', attemptNumber: 2, status: 'FAILED', candidateId: 'cand-1' },
      ]);
      mockPrisma.$queryRaw.mockResolvedValue([{ max: '2' }]);
      mockPrisma.suppressedEmail.findMany.mockResolvedValue([]);
      mockPrisma.subscriber.findUnique.mockResolvedValue({ id: 'sub-1', email: 'alice@example.com', consented: true });
      mockPrisma.campaignSendLog.count.mockResolvedValue(0);
      mockPrisma.campaignSend.update.mockResolvedValue({});
      mockSendEmail.fn.mockResolvedValue({ success: false, error: 'SES failure' });

      const result = await retryFailedCampaignSend('send-1', 'admin-1');

      expect(result.retried).toBe(1);
      expect(result.stillFailed).toBe(1);
      expect(result.remainingFailed).toBe(1);
      expect(mockSendEmail.fn).toHaveBeenCalledTimes(1);
      expect(mockPrisma.campaignSendLog.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ attemptNumber: 3 }) })
      );
      expect(mockPrisma.campaignSend.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'FAILED' }) })
      );
    });

    it('computes retry completion from the latest attempt, not the historical FAILED-row count', async () => {
      mockConfig.bulkCampaignSendsEnabled = true;
      const send = buildApprovedSend({ status: 'FAILED' });
      mockPrisma.campaignSend.findUnique.mockResolvedValue(send);
      mockPrisma.campaignSend.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.campaignSendLog.findMany.mockResolvedValue([
        { id: 'l1', email: 'alice@example.com', attemptNumber: 1, status: 'FAILED', candidateId: 'cand-1' },
        { id: 'l2', email: 'alice@example.com', attemptNumber: 2, status: 'FAILED', candidateId: 'cand-1' },
        { id: 'l3', email: 'alice@example.com', attemptNumber: 3, status: 'FAILED', candidateId: 'cand-1' },
      ]);
      mockPrisma.$queryRaw.mockResolvedValue([{ max: '3' }]);
      mockPrisma.suppressedEmail.findMany.mockResolvedValue([]);
      mockPrisma.subscriber.findUnique.mockResolvedValue({ id: 'sub-1', email: 'alice@example.com', consented: true });
      mockPrisma.campaignSend.update.mockResolvedValue({});

      const result = await retryFailedCampaignSend('send-1', 'admin-1');

      expect(result.retried).toBe(1);
      expect(result.remainingFailed).toBe(0);
      expect(result.sent).toBe(1);
      expect(mockPrisma.campaignSend.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'SENT' }) })
      );
    });
  });

  describe('sendCampaign ambiguous states', () => {
    it('marks a log AMBIGUOUS when SES succeeds but the audit update fails', async () => {
      mockConfig.bulkCampaignSendsEnabled = true;
      const send = buildApprovedSend();
      mockPrisma.campaignSend.findUnique.mockResolvedValue(send);
      mockPrisma.campaignSend.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.campaignSend.update.mockResolvedValue({});
      mockPrisma.suppressedEmail.findMany.mockResolvedValue([]);
      mockPrisma.subscriber.findUnique.mockResolvedValue({ id: 'sub-1', email: 'alice@example.com', consented: true });
      mockPrisma.campaignSendLog.update
        .mockRejectedValueOnce(new Error('write failed'))
        .mockResolvedValueOnce({});

      const result = await sendCampaign('send-1', 'admin-1');

      expect(result.sent).toBe(1);
      expect(result.ambiguous).toBe(1);
      expect(mockSendEmail.fn).toHaveBeenCalledTimes(1);
      expect(mockPrisma.campaignSendLog.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'AMBIGUOUS' }) })
      );
    });

    it('does not perform a second SES effect when the first succeeded but the log update failed', async () => {
      mockConfig.bulkCampaignSendsEnabled = true;
      const send = buildApprovedSend();
      mockPrisma.campaignSend.findUnique.mockResolvedValue(send);
      mockPrisma.campaignSend.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.campaignSend.update.mockResolvedValue({});
      mockPrisma.suppressedEmail.findMany.mockResolvedValue([]);
      mockPrisma.subscriber.findUnique.mockResolvedValue({ id: 'sub-1', email: 'alice@example.com', consented: true });
      mockPrisma.campaignSendLog.update.mockRejectedValue(new Error('write failed'));

      const result = await sendCampaign('send-1', 'admin-1');

      expect(result.sent).toBe(1);
      expect(mockSendEmail.fn).toHaveBeenCalledTimes(1);
    });
  });

  describe('previewCampaignSend', () => {
    it('returns the recipient count, sample, and rendered preview for a send', async () => {
      const send = buildApprovedSend({
        id: 'send-1',
        status: 'PENDING_APPROVAL',
        template: { name: 'Welcome', subject: 'Hi {{name}}', body: '<p>Hello {{name}}</p>' },
        audience: { filters: { statuses: ['ACCEPTED'] } },
      });
      mockPrisma.campaignSend.findUnique.mockResolvedValue(send);
      mockPrisma.subscriber.findMany.mockResolvedValue([
        subscriberWithCandidate({ email: 'a@example.com' }),
        subscriberWithCandidate({ email: 'b@example.com' }),
      ]);
      mockPrisma.suppressedEmail.findMany.mockResolvedValue([]);

      const result = await previewCampaignSend({ sendId: 'send-1' });

      expect(result.count).toBe(2);
      expect(result.sample).toHaveLength(2);
      expect(result.renderedPreview).toContain('Hello Alice');
    });
  });

  describe('reconcileCampaignLogs', () => {
    it('marks stale PENDING logs as AMBIGUOUS', async () => {
      const now = Date.now();
      const staleLog = { id: 'log-1', email: 'alice@example.com', status: 'PENDING', createdAt: new Date(now - 10 * 60 * 1000) };
      mockPrisma.campaignSendLog.findMany.mockImplementation(({ where }) => {
        if (where?.createdAt?.lt && staleLog.createdAt >= where.createdAt.lt) return Promise.resolve([]);
        return Promise.resolve([staleLog]);
      });

      const results = await reconcileCampaignLogs({ olderThanMs: 5 * 60 * 1000, now });

      expect(results).toEqual([{ id: 'log-1', status: 'AMBIGUOUS' }]);
      expect(mockPrisma.campaignSendLog.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'log-1' }, data: { status: 'AMBIGUOUS', sentAt: expect.any(Date) } })
      );
    });

    it('does not touch recent PENDING logs', async () => {
      const now = Date.now();
      const recentLog = { id: 'log-1', email: 'alice@example.com', status: 'PENDING', createdAt: new Date(now - 60 * 1000) };
      mockPrisma.campaignSendLog.findMany.mockImplementation(({ where }) => {
        if (where?.createdAt?.lt && recentLog.createdAt >= where.createdAt.lt) return Promise.resolve([]);
        return Promise.resolve([recentLog]);
      });

      const results = await reconcileCampaignLogs({ olderThanMs: 5 * 60 * 1000, now });

      expect(results).toEqual([]);
      expect(mockPrisma.campaignSendLog.update).not.toHaveBeenCalled();
    });
  });

  describe('resolveCampaignLog', () => {
    it('allows an admin to resolve an AMBIGUOUS log to SENT with an audit record', async () => {
      const log = { id: 'log-1', status: 'AMBIGUOUS', providerMessageId: 'ses-123', sentAt: null, campaignSendId: 'send-1' };
      mockPrisma.campaignSendLog.findUnique.mockResolvedValue(log);
      mockPrisma.campaignSendLog.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.campaignSendLogResolution.create.mockResolvedValue({ id: 'res-1' });

      const result = await resolveCampaignLog({ logId: 'log-1', actorId: 'admin-1', status: 'SENT', reason: 'confirmed delivery' });

      expect(result.status).toBe('SENT');
      expect(mockPrisma.$transaction).toHaveBeenCalled();
      expect(mockPrisma.campaignSendLog.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ id: 'log-1', status: { in: ['PENDING', 'AMBIGUOUS'] } }),
        })
      );
      expect(mockPrisma.campaignSendLogResolution.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ logId: 'log-1', status: 'SENT', reason: 'confirmed delivery', actorId: 'admin-1' }),
        })
      );
    });

    it('rejects resolving a log that is not PENDING or AMBIGUOUS', async () => {
      mockPrisma.campaignSendLog.findUnique.mockResolvedValue({ id: 'log-1', status: 'SENT' });

      await expect(resolveCampaignLog({ logId: 'log-1', actorId: 'admin-1', status: 'FAILED' })).rejects.toThrow(/cannot be resolved/i);
    });

    it('rejects an invalid resolution status', async () => {
      mockPrisma.campaignSendLog.findUnique.mockResolvedValue({ id: 'log-1', status: 'AMBIGUOUS' });

      await expect(resolveCampaignLog({ logId: 'log-1', actorId: 'admin-1', status: 'PENDING', reason: 'bad status' })).rejects.toThrow(/SENT or FAILED/i);
    });

    it('rejects resolving an AMBIGUOUS log without a non-empty trimmed reason', async () => {
      mockPrisma.campaignSendLog.findUnique.mockResolvedValue({ id: 'log-1', status: 'AMBIGUOUS' });

      await expect(resolveCampaignLog({ logId: 'log-1', actorId: 'admin-1', status: 'SENT', reason: '   ' })).rejects.toThrow(/reason is required/i);
      expect(mockPrisma.campaignSendLogResolution.create).not.toHaveBeenCalled();
    });

    it('only lets one concurrent resolution win and prevents duplicate audit records', async () => {
      const log = { id: 'log-1', status: 'AMBIGUOUS', providerMessageId: 'ses-123', sentAt: null, campaignSendId: 'send-1' };
      mockPrisma.campaignSendLog.findUnique.mockResolvedValue(log);
      mockPrisma.campaignSendLog.updateMany.mockResolvedValue({ count: 0 });

      await expect(resolveCampaignLog({ logId: 'log-1', actorId: 'admin-1', status: 'SENT', reason: 'already resolved' })).rejects.toThrow(/already resolved/i);

      expect(mockPrisma.campaignSendLogResolution.create).not.toHaveBeenCalled();
    });

    it('is idempotent and returns the existing audit record when retried', async () => {
      const log = { id: 'log-1', status: 'SENT', providerMessageId: 'ses-123', sentAt: new Date(), campaignSendId: 'send-1', resolutions: [{ id: 'res-1', status: 'SENT' }] };
      mockPrisma.campaignSendLog.findUnique.mockResolvedValue(log);

      const result = await resolveCampaignLog({ logId: 'log-1', actorId: 'admin-1', status: 'SENT', reason: 'retry' });

      expect(result.alreadyResolved).toBe(true);
      expect(result.resolution.id).toBe('res-1');
      expect(mockPrisma.campaignSendLogResolution.create).not.toHaveBeenCalled();
    });

    it('creates one audit record and recomputes the campaign aggregate', async () => {
      const log = { id: 'log-1', status: 'AMBIGUOUS', providerMessageId: 'ses-123', sentAt: null, campaignSendId: 'send-1' };
      mockPrisma.campaignSendLog.findUnique.mockResolvedValue(log);
      mockPrisma.campaignSendLog.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.campaignSendLogResolution.create.mockResolvedValue({ id: 'res-1' });
      mockPrisma.campaignSend.findUnique.mockResolvedValue({
        id: 'send-1',
        status: 'SENDING',
        sentAt: null,
        recipientCount: 0,
        failedRecipientCount: 0,
        logs: [{ id: 'log-1', email: 'a@example.com', attemptNumber: 1, status: 'SENT' }],
      });
      mockPrisma.campaignSend.update.mockResolvedValue({});

      const result = await resolveCampaignLog({ logId: 'log-1', actorId: 'admin-1', status: 'SENT', reason: 'provider confirmed delivery' });

      expect(result.resolution.id).toBe('res-1');
      expect(mockPrisma.campaignSendLogResolution.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.campaignSend.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'send-1' },
          data: expect.objectContaining({ status: 'SENT', recipientCount: 1, failedRecipientCount: 0 }),
        })
      );
    });

    it('commits one audit event and reconciles to one terminal aggregate when recompute fails', async () => {
      const log = { id: 'log-1', status: 'AMBIGUOUS', providerMessageId: 'ses-123', sentAt: null, campaignSendId: 'send-1' };
      mockPrisma.campaignSendLog.findUnique.mockResolvedValue(log);
      mockPrisma.campaignSendLog.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.campaignSendLogResolution.create.mockResolvedValue({ id: 'res-1' });
      mockPrisma.campaignSendLog.findMany.mockResolvedValue([]);
      mockPrisma.campaignSend.findMany.mockResolvedValue([{ id: 'send-1' }]);
      mockPrisma.campaignSend.findUnique.mockResolvedValue({
        id: 'send-1',
        status: 'SENDING',
        sentAt: null,
        recipientCount: 0,
        failedRecipientCount: 0,
        logs: [{ id: 'log-1', email: 'a@example.com', attemptNumber: 1, status: 'SENT' }],
      });
      mockPrisma.campaignSend.update
        .mockRejectedValueOnce(new Error('aggregate update failed'))
        .mockResolvedValue({});

      const result = await resolveCampaignLog({ logId: 'log-1', actorId: 'admin-1', status: 'SENT', reason: 'provider confirmed delivery' });

      // Resolution audit event is committed exactly once even though recompute fails.
      expect(result.resolution.id).toBe('res-1');
      expect(mockPrisma.campaignSendLogResolution.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.campaignSend.update).toHaveBeenCalled();

      await reconcileCampaignSendAggregates();

      const updateCalls = mockPrisma.campaignSend.update.mock.calls.filter(
        (call) => call[0]?.where?.id === 'send-1'
      );
      expect(updateCalls.length).toBeGreaterThanOrEqual(1);
      expect(updateCalls[updateCalls.length - 1][0].data).toMatchObject({
        status: 'SENT',
        recipientCount: 1,
        failedRecipientCount: 0,
      });
    });
  });

  describe('reconcileCampaignSendAggregates', () => {
    it('repairs a stale aggregate and marks mixed SENT/FAILED outcomes as PARTIAL', async () => {
      mockPrisma.campaignSendLog.findMany.mockResolvedValue([]);
      mockPrisma.campaignSend.findMany.mockResolvedValue([{ id: 'send-1' }]);
      mockPrisma.campaignSend.findUnique.mockResolvedValue({
        id: 'send-1',
        status: 'SENDING',
        sentAt: null,
        recipientCount: 0,
        failedRecipientCount: 0,
        logs: [
          { id: 'l1', email: 'a@example.com', attemptNumber: 1, status: 'SENT' },
          { id: 'l2', email: 'b@example.com', attemptNumber: 1, status: 'FAILED' },
        ],
      });
      mockPrisma.campaignSend.update.mockResolvedValue({});

      await reconcileCampaignSendAggregates();

      expect(mockPrisma.campaignSend.findMany).toHaveBeenCalled();
      expect(mockPrisma.campaignSend.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'send-1' },
          data: expect.objectContaining({ status: 'PARTIAL', recipientCount: 1, failedRecipientCount: 1 }),
        })
      );
    });

    it('does not update an aggregate that is already consistent', async () => {
      mockPrisma.campaignSendLog.findMany.mockResolvedValue([]);
      mockPrisma.campaignSend.findMany.mockResolvedValue([{ id: 'send-1' }]);
      mockPrisma.campaignSend.findUnique.mockResolvedValue({
        id: 'send-1',
        status: 'PARTIAL',
        sentAt: new Date(),
        recipientCount: 1,
        failedRecipientCount: 1,
        logs: [
          { id: 'l1', email: 'a@example.com', attemptNumber: 1, status: 'SENT' },
          { id: 'l2', email: 'b@example.com', attemptNumber: 1, status: 'FAILED' },
        ],
      });

      await reconcileCampaignSendAggregates();

      expect(mockPrisma.campaignSend.update).not.toHaveBeenCalled();
    });
  });

  describe('recordSuppression', () => {
    it('adds the email to the suppression list and revokes subscriber consent', async () => {
      mockPrisma.suppressedEmail.upsert.mockResolvedValue({ email: 'bounce@example.com' });
      mockPrisma.subscriber.findUnique.mockResolvedValue({
        id: 'sub-1',
        email: 'bounce@example.com',
        consented: true,
      });
      mockPrisma.subscriber.upsert.mockResolvedValue({ id: 'sub-1', email: 'bounce@example.com', consented: false });
      mockPrisma.consentEvent.create.mockResolvedValue({});

      await recordSuppression({ email: 'bounce@example.com', reason: 'bounce', source: 'ses' });

      expect(mockPrisma.suppressedEmail.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: 'bounce@example.com' },
          create: expect.objectContaining({ email: 'bounce@example.com', reason: 'bounce', source: 'ses' }),
        })
      );
      expect(mockPrisma.subscriber.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { email: 'bounce@example.com' },
          update: expect.objectContaining({ consented: false }),
        })
      );
      expect(mockPrisma.consentEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ consented: false, source: 'ses' }),
        })
      );
    });
  });
});
