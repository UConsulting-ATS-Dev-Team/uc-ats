// SES delivery events -> communication_logs.
//
// Two things are worth pinning down: a message that SNS did not sign is never
// believed, and an event only ever moves a row forward, so SNS delivering
// events out of order cannot turn a bounce back into "Delivered".
import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import prisma from '../prismaClient.js';
import { verifySnsMessage, stringToSign, interpretSesEvent, applySesEvent, isSnsUrl } from './sesEvents.js';
import { suppressEmail } from './emailSuppression.js';

vi.mock('../prismaClient.js', () => ({
  default: { communicationLog: { updateMany: vi.fn() } },
}));
vi.mock('./emailSuppression.js', () => ({ suppressEmail: vi.fn() }));

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const fetchCert = async () => publicPem;

const CERT_URL = 'https://sns.us-west-1.amazonaws.com/SimpleNotificationService-abc.pem';

function signed(fields, { version = '2', key = privateKey } = {}) {
  const message = {
    Type: 'Notification',
    MessageId: 'sns-1',
    TopicArn: 'arn:aws:sns:us-west-1:1:ats',
    Message: '{}',
    Timestamp: '2026-09-22T12:00:00.000Z',
    SignatureVersion: version,
    SigningCertURL: CERT_URL,
    ...fields,
  };
  const algorithm = version === '1' ? 'RSA-SHA1' : 'RSA-SHA256';
  message.Signature = crypto.sign(algorithm, Buffer.from(stringToSign(message)), key).toString('base64');
  return message;
}

describe('verifySnsMessage', () => {
  it('accepts a correctly signed notification, either signature version', async () => {
    expect(await verifySnsMessage(signed({}), { fetchCert })).toBe(true);
    expect(await verifySnsMessage(signed({}, { version: '1' }), { fetchCert })).toBe(true);
  });

  it('accepts a signed subscription confirmation', async () => {
    const message = signed({
      Type: 'SubscriptionConfirmation',
      Token: 'tok',
      SubscribeURL: 'https://sns.us-west-1.amazonaws.com/?Action=ConfirmSubscription',
    });
    expect(await verifySnsMessage(message, { fetchCert })).toBe(true);
  });

  it('rejects a message altered after signing', async () => {
    const message = signed({ Message: '{"eventType":"Delivery"}' });
    message.Message = '{"eventType":"Bounce"}';
    expect(await verifySnsMessage(message, { fetchCert })).toBe(false);
  });

  it('rejects a message signed with somebody else’s key', async () => {
    const other = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;
    expect(await verifySnsMessage(signed({}, { key: other }), { fetchCert })).toBe(false);
  });

  it('never fetches a certificate from outside SNS', async () => {
    const spy = vi.fn(fetchCert);
    const message = signed({ SigningCertURL: 'https://evil.example.com/cert.pem' });
    expect(await verifySnsMessage(message, { fetchCert: spy })).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('rejects an unknown signature version', async () => {
    const message = signed({});
    message.SignatureVersion = '3';
    expect(await verifySnsMessage(message, { fetchCert })).toBe(false);
  });
});

describe('isSnsUrl', () => {
  it.each([
    ['https://sns.us-east-1.amazonaws.com/x', true],
    ['https://sns.cn-north-1.amazonaws.com.cn/x', true],
    ['http://sns.us-east-1.amazonaws.com/x', false],
    ['https://sns.us-east-1.amazonaws.com.evil.com/x', false],
    ['https://evil.com/sns.us-east-1.amazonaws.com', false],
    ['not a url', false],
  ])('%s -> %s', (url, expected) => {
    expect(isSnsUrl(url)).toBe(expected);
  });
});

const mail = { messageId: 'ses-123', destination: ['ryan@example.com'] };

describe('interpretSesEvent', () => {
  it('keeps the recipient server’s diagnostic on a bounce', () => {
    const out = interpretSesEvent({
      eventType: 'Bounce',
      mail,
      bounce: {
        bounceType: 'Permanent',
        bounceSubType: 'NoEmail',
        bouncedRecipients: [{ emailAddress: 'Ryan <ryan@example.com>', diagnosticCode: 'smtp; 550 5.1.1 user unknown' }],
      },
    });
    expect(out.status).toBe('BOUNCED');
    expect(out.recipients).toEqual([
      { address: 'ryan@example.com', detail: 'Permanent bounce (NoEmail): smtp; 550 5.1.1 user unknown' },
    ]);
  });

  it('reads identity notifications (notificationType) the same as configuration-set events', () => {
    const out = interpretSesEvent({ notificationType: 'Delivery', mail, delivery: { recipients: ['ryan@example.com'] } });
    expect(out).toMatchObject({ status: 'DELIVERED', recipients: ['ryan@example.com'] });
  });

  it('ignores events the log has no use for', () => {
    expect(interpretSesEvent({ eventType: 'Open', mail })).toBeNull();
    expect(interpretSesEvent({ eventType: 'Send', mail })).toBeNull();
  });
});

describe('applySesEvent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.communicationLog.updateMany.mockResolvedValue({ count: 1 });
  });

  it('updates the row for that SES message and recipient only', async () => {
    await applySesEvent({
      eventType: 'Complaint',
      mail,
      complaint: { complaintFeedbackType: 'abuse', complainedRecipients: [{ emailAddress: 'ryan@example.com' }] },
    });
    const [{ where, data }] = prisma.communicationLog.updateMany.mock.calls[0];
    expect(where.providerMessageId).toEqual({ startsWith: '<ses-123@' });
    expect(where.recipient).toEqual({ equals: 'ryan@example.com', mode: 'insensitive' });
    expect(data).toEqual({ status: 'COMPLAINED', error: 'Recipient marked this as spam (abuse)' });
  });

  it('never lets a late delivery overwrite a bounce or a complaint', async () => {
    await applySesEvent({ eventType: 'Delivery', mail, delivery: { recipients: ['ryan@example.com'] } });
    const [{ where }] = prisma.communicationLog.updateMany.mock.calls[0];
    expect(where.status.in.sort()).toEqual(['DELAYED', 'SENT']);
  });

  it('clears a delay note once the message is delivered', async () => {
    await applySesEvent({ eventType: 'Delivery', mail, delivery: { recipients: ['ryan@example.com'] } });
    const [{ data }] = prisma.communicationLog.updateMany.mock.calls[0];
    expect(data).toEqual({ status: 'DELIVERED', error: null });
  });

  it('lets a complaint follow a delivery', async () => {
    await applySesEvent({ eventType: 'Complaint', mail, complaint: { complainedRecipients: [{ emailAddress: 'ryan@example.com' }] } });
    const [{ where }] = prisma.communicationLog.updateMany.mock.calls[0];
    expect(where.status.in).toContain('DELIVERED');
    expect(where.status.in).toContain('BOUNCED');
  });

  it('writes one update per bounced recipient', async () => {
    const count = await applySesEvent({
      eventType: 'Bounce',
      mail: { messageId: 'ses-9', destination: ['a@x.com', 'b@x.com'] },
      bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'a@x.com' }, { emailAddress: 'b@x.com' }] },
    });
    expect(prisma.communicationLog.updateMany).toHaveBeenCalledTimes(2);
    expect(count).toBe(2);
  });

  // Marketing sends stop going to an address that complained or does not
  // exist. A soft bounce - a full mailbox - is worth trying again, so it does not.
  it('unsubscribes a complaint and a permanent bounce, not a transient one', async () => {
    await applySesEvent({ eventType: 'Complaint', mail, complaint: { complainedRecipients: [{ emailAddress: 'ryan@example.com' }] } });
    expect(suppressEmail).toHaveBeenLastCalledWith(expect.objectContaining({ email: 'ryan@example.com', reason: 'COMPLAINED', source: 'SES' }));

    await applySesEvent({
      eventType: 'Bounce',
      mail,
      bounce: { bounceType: 'Permanent', bounceSubType: 'General', bouncedRecipients: [{ emailAddress: 'ryan@example.com', diagnosticCode: '550 user unknown' }] },
    });
    expect(suppressEmail).toHaveBeenLastCalledWith(expect.objectContaining({ reason: 'BOUNCED', detail: expect.stringContaining('550 user unknown') }));

    suppressEmail.mockClear();
    await applySesEvent({ eventType: 'Bounce', mail, bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'ryan@example.com' }] } });
    await applySesEvent({ eventType: 'Delivery', mail, delivery: { recipients: ['ryan@example.com'] } });
    expect(suppressEmail).not.toHaveBeenCalled();
  });

  it('still reports the log update when recording the unsubscribe fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    prisma.communicationLog.updateMany.mockResolvedValue({ count: 1 });
    suppressEmail.mockRejectedValueOnce(new Error('db down'));
    const count = await applySesEvent({ eventType: 'Complaint', mail, complaint: { complainedRecipients: [{ emailAddress: 'ryan@example.com' }] } });
    expect(count).toBe(1);
  });

  it('does nothing without an SES message id', async () => {
    expect(await applySesEvent({ eventType: 'Delivery', mail: {} })).toBe(0);
    expect(prisma.communicationLog.updateMany).not.toHaveBeenCalled();
  });
});
