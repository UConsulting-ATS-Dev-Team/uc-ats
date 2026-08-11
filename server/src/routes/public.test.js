import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import express from 'express';

const mockConfig = vi.hoisted(() => ({
  sesSnsTopicArn: 'arn:aws:sns:us-east-1:123456789012:ses-events',
  sesSnsVerifySignature: true,
}));

const mockVerifySnsSignature = vi.hoisted(() => vi.fn());
const mockRecordSuppression = vi.hoisted(() => vi.fn());

vi.mock('../config.js', () => ({
  default: mockConfig,
}));

vi.mock('../prismaClient.js', () => ({
  default: {
    meetingSlot: { findMany: vi.fn().mockResolvedValue([]) },
    recruitingCycle: { findFirst: vi.fn().mockResolvedValue(null) },
    event: { findMany: vi.fn().mockResolvedValue([]) },
    suppressedEmail: { findMany: vi.fn().mockResolvedValue([]) },
  },
}));

vi.mock('../services/emailNotifications.js', () => ({
  sendMeetingSignupConfirmation: vi.fn(),
  sendMeetingSignupNotification: vi.fn(),
  sendMeetingCancellationToMember: vi.fn(),
}));

vi.mock('../services/meetingComms.js', () => ({
  sendAndLogMeetingCommunication: vi.fn(),
  MEETING_COMM_SUBJECTS: {},
}));

vi.mock('../services/campaigns.js', () => ({
  verifyUnsubscribeToken: vi.fn(),
  recordSuppression: (...args) => mockRecordSuppression(...args),
}));

vi.mock('../utils/snsVerification.js', () => ({
  verifySnsSignature: (...args) => mockVerifySnsSignature(...args),
}));

import publicRoutes from './public.js';

describe('public routes /api/ses-events', () => {
  let app;
  let server;
  let port;

  beforeAll(async () => {
    app = express();
    app.use(express.json({ type: '*/*' }));
    app.use('/api', publicRoutes);
    server = app.listen(0);
    await new Promise((resolve) => server.on('listening', resolve));
    port = server.address().port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig.sesSnsTopicArn = 'arn:aws:sns:us-east-1:123456789012:ses-events';
    mockConfig.sesSnsVerifySignature = true;
    mockRecordSuppression.mockResolvedValue(undefined);
  });

  async function post(path, body) {
    return fetch(`http://localhost:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('rejects direct (non-SNS) SES bodies and does not mutate suppression state', async () => {
    const res = await post('/api/ses-events', {
      notificationType: 'Complaint',
      complaint: { complainedRecipients: [{ emailAddress: 'victim@example.com' }] },
    });

    expect(res.status).toBe(403);
    expect(mockRecordSuppression).not.toHaveBeenCalled();
    expect(mockVerifySnsSignature).not.toHaveBeenCalled();
  });

  it('rejects SNS notifications when the SES topic is not configured', async () => {
    mockConfig.sesSnsTopicArn = null;

    const res = await post('/api/ses-events', {
      Type: 'Notification',
      Message: JSON.stringify({ notificationType: 'Bounce', bounce: { bouncedRecipients: [{ emailAddress: 'a@example.com' }] } }),
      Signature: 'valid',
      SigningCertURL: 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-123.pem',
    });

    expect(res.status).toBe(403);
    expect(mockRecordSuppression).not.toHaveBeenCalled();
    expect(mockVerifySnsSignature).not.toHaveBeenCalled();
  });

  it('rejects forged SNS notifications without mutating suppression state', async () => {
    mockVerifySnsSignature.mockRejectedValue(new Error('SNS signature verification failed'));

    const res = await post('/api/ses-events', {
      Type: 'Notification',
      Message: JSON.stringify({ notificationType: 'Bounce', bounce: { bouncedRecipients: [{ emailAddress: 'a@example.com' }] } }),
      Signature: 'forged',
      SigningCertURL: 'https://sns.us-east-1.amazonaws.com/SimpleNotificationService-123.pem',
    });

    expect(res.status).toBe(403);
    expect(mockRecordSuppression).not.toHaveBeenCalled();
  });

  it('rejects notifications from the wrong SNS topic', async () => {
    mockVerifySnsSignature.mockRejectedValue(new Error('SNS topic mismatch'));

    const res = await post('/api/ses-events', {
      Type: 'Notification',
      Message: JSON.stringify({ notificationType: 'Bounce', bounce: { bouncedRecipients: [{ emailAddress: 'a@example.com' }] } }),
      TopicArn: 'arn:aws:sns:us-east-1:123456789012:other-topic',
    });

    expect(res.status).toBe(403);
    expect(mockRecordSuppression).not.toHaveBeenCalled();
  });

  it('records suppression for a valid SNS bounce notification', async () => {
    mockVerifySnsSignature.mockResolvedValue(true);

    const res = await post('/api/ses-events', {
      Type: 'Notification',
      Message: JSON.stringify({ notificationType: 'Bounce', bounce: { bouncedRecipients: [{ emailAddress: 'bounce@example.com' }] } }),
      TopicArn: mockConfig.sesSnsTopicArn,
      Signature: 'valid',
      SigningCertURL: 'https://sns.us-east-1.amazonaws.com/cert.pem',
    });

    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.processed).toBe(1);
    expect(mockRecordSuppression).toHaveBeenCalledWith({ email: 'bounce@example.com', reason: 'bounce', source: 'ses' });
  });
});
