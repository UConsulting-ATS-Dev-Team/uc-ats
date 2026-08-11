import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'crypto';
import {
  buildSnsStringToSign,
  verifySnsSignature,
  isValidSnsSigningCertUrl,
  clearSigningCertCache,
} from './snsVerification.js';

describe('snsVerification', () => {
  let keyPair;
  const now = new Date('2026-08-10T12:00:00.000Z').getTime();
  const topicArn = 'arn:aws:sns:us-east-2:123456789012:uc-ats-ses-events';

  beforeEach(() => {
    clearSigningCertCache();
    keyPair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  });

  function makeCertFetcher(publicKeyPem) {
    return vi.fn().mockResolvedValue(publicKeyPem);
  }

  function signPayload(privateKey, payload) {
    const stringToSign = buildSnsStringToSign(payload);
    const signatureVersion = payload.SignatureVersion || '1';
    const algorithm = signatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';
    return crypto.sign(algorithm, Buffer.from(stringToSign, 'utf8'), privateKey).toString('base64');
  }

  function buildNotification(overrides = {}) {
    const payload = {
      Type: 'Notification',
      MessageId: 'msg-1',
      TopicArn: topicArn,
      Subject: 'SES Event',
      Message: JSON.stringify({ notificationType: 'Bounce', bounce: { bouncedRecipients: [{ emailAddress: 'a@example.com' }] } }),
      Timestamp: new Date(now).toISOString(),
      SignatureVersion: '1',
      SigningCertURL: 'https://sns.us-east-2.amazonaws.com/SimpleNotificationService-f3ecfb7224c7233fe7bb5f59f96de52f.pem',
      ...overrides,
    };
    payload.Signature = signPayload(keyPair.privateKey, payload);
    return payload;
  }

  it('validates a genuine SNS notification with matching topic', async () => {
    const payload = buildNotification();
    await expect(
      verifySnsSignature(payload, {
        requiredTopicArn: topicArn,
        getSigningCert: makeCertFetcher(keyPair.publicKey.export({ type: 'spki', format: 'pem' })),
        verifyCertificate: false,
        now,
      })
    ).resolves.toBe(true);
  });

  it('rejects a notification with the wrong topic', async () => {
    const payload = buildNotification();
    await expect(
      verifySnsSignature(payload, {
        requiredTopicArn: 'arn:aws:sns:us-east-2:123456789012:wrong-topic',
        getSigningCert: makeCertFetcher(keyPair.publicKey.export({ type: 'spki', format: 'pem' })),
        verifyCertificate: false,
        now,
      })
    ).rejects.toThrow(/topic mismatch/i);
  });

  it('rejects a forged signature', async () => {
    const otherKey = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const basePayload = buildNotification({ Signature: undefined });
    basePayload.Signature = signPayload(otherKey.privateKey, basePayload);
    await expect(
      verifySnsSignature(basePayload, {
        requiredTopicArn: topicArn,
        getSigningCert: makeCertFetcher(keyPair.publicKey.export({ type: 'spki', format: 'pem' })),
        verifyCertificate: false,
        now,
      })
    ).rejects.toThrow(/signature verification failed/i);
  });

  it('rejects a tampered message body', async () => {
    const payload = buildNotification();
    payload.Message = JSON.stringify({ notificationType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'a@example.com' }] } });
    await expect(
      verifySnsSignature(payload, {
        requiredTopicArn: topicArn,
        getSigningCert: makeCertFetcher(keyPair.publicKey.export({ type: 'spki', format: 'pem' })),
        verifyCertificate: false,
        now,
      })
    ).rejects.toThrow(/signature verification failed/i);
  });

  it('rejects an untrusted certificate URL', async () => {
    const payload = buildNotification({ SigningCertURL: 'https://attacker.example.com/cert.pem' });
    await expect(
      verifySnsSignature(payload, {
        requiredTopicArn: topicArn,
        getSigningCert: vi.fn(),
        verifyCertificate: false,
        now,
      })
    ).rejects.toThrow(/Untrusted SNS signing certificate URL/i);
  });

  it('rejects an expired timestamp', async () => {
    const payload = buildNotification({ Timestamp: new Date(now - 30 * 60 * 1000).toISOString() });
    await expect(
      verifySnsSignature(payload, {
        requiredTopicArn: topicArn,
        getSigningCert: makeCertFetcher(keyPair.publicKey.export({ type: 'spki', format: 'pem' })),
        verifyCertificate: false,
        now,
      })
    ).rejects.toThrow(/timestamp is too old/i);
  });

  it('supports SignatureVersion 2 (SHA256)', async () => {
    const payload = buildNotification({ SignatureVersion: '2' });
    await expect(
      verifySnsSignature(payload, {
        requiredTopicArn: topicArn,
        getSigningCert: makeCertFetcher(keyPair.publicKey.export({ type: 'spki', format: 'pem' })),
        verifyCertificate: false,
        now,
      })
    ).resolves.toBe(true);
  });

  it('validates subscription confirmation messages', async () => {
    const payload = {
      Type: 'SubscriptionConfirmation',
      MessageId: 'msg-2',
      Token: 'token-1',
      TopicArn: topicArn,
      Message: 'You have chosen to subscribe...',
      SubscribeURL: 'https://sns.us-east-2.amazonaws.com/?Action=ConfirmSubscription&TopicArn=arn:aws:sns:us-east-2:123456789012:uc-ats-ses-events&Token=token-1',
      Timestamp: new Date(now).toISOString(),
      SignatureVersion: '1',
      SigningCertURL: 'https://sns.us-east-2.amazonaws.com/SimpleNotificationService-f3ecfb7224c7233fe7bb5f59f96de52f.pem',
    };
    payload.Signature = signPayload(keyPair.privateKey, payload);
    await expect(
      verifySnsSignature(payload, {
        requiredTopicArn: topicArn,
        getSigningCert: makeCertFetcher(keyPair.publicKey.export({ type: 'spki', format: 'pem' })),
        verifyCertificate: false,
        now,
      })
    ).resolves.toBe(true);
  });

  it('does not allow verify=false to disable signature validation', async () => {
    const payload = buildNotification();
    payload.Signature = 'invalid';
    await expect(
      verifySnsSignature(payload, {
        requiredTopicArn: topicArn,
        getSigningCert: makeCertFetcher(keyPair.publicKey.export({ type: 'spki', format: 'pem' })),
        verifyCertificate: false,
        now,
      })
    ).rejects.toThrow(/signature verification failed/i);
  });
});

describe('isValidSnsSigningCertUrl', () => {
  it('accepts a real SNS signing cert URL', () => {
    expect(isValidSnsSigningCertUrl('https://sns.us-east-2.amazonaws.com/SimpleNotificationService-f3ecfb7224c7233fe7bb5f59f96de52f.pem')).toBe(true);
  });

  it('rejects HTTP URLs', () => {
    expect(isValidSnsSigningCertUrl('http://sns.us-east-2.amazonaws.com/cert.pem')).toBe(false);
  });

  it('rejects non-AWS hosts', () => {
    expect(isValidSnsSigningCertUrl('https://sns.attacker.amazonaws.com.evil.com/cert.pem')).toBe(false);
    expect(isValidSnsSigningCertUrl('https://example.com/cert.pem')).toBe(false);
  });

  it('rejects non-pem paths', () => {
    expect(isValidSnsSigningCertUrl('https://sns.us-east-2.amazonaws.com/cert.txt')).toBe(false);
  });
});
