// The deliverability page is only useful if it never calls a working setup
// broken, and never calls a broken one fine. These pin the judgement calls.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../prismaClient.js', () => ({
  default: {
    communicationLog: { groupBy: vi.fn(), count: vi.fn(), findMany: vi.fn(), findFirst: vi.fn() },
    emailSuppression: { groupBy: vi.fn() },
  },
}));

import prisma from '../prismaClient.js';

import {
  STATUS,
  worstStatus,
  parseFromAddress,
  configurationChecks,
  interpretAccount,
  interpretIdentity,
  interpretEventDestinations,
  interpretSpf,
  interpretDmarc,
  summarizeDelivery,
  sesChecks,
  dnsChecks,
  deliveryReport,
  emailHealthReport,
} from './emailHealth.js';

const byKey = (checks) => Object.fromEntries(checks.map((c) => [c.key, c]));

describe('parseFromAddress', () => {
  it('reads a display-name address and a bare one', () => {
    expect(parseFromAddress('UConsulting <NoReply@UC.org>')).toBe('noreply@uc.org');
    expect(parseFromAddress('noreply@uc.org')).toBe('noreply@uc.org');
    expect(parseFromAddress('not an address')).toBeNull();
    expect(parseFromAddress(undefined)).toBeNull();
  });
});

describe('worstStatus', () => {
  it('ranks fail over warn over unknown, and info as ok', () => {
    expect(worstStatus(['ok', 'info'])).toBe('ok');
    expect(worstStatus(['ok', 'unknown'])).toBe('unknown');
    expect(worstStatus(['unknown', 'warn', 'ok'])).toBe('warn');
    expect(worstStatus(['warn', 'fail'])).toBe('fail');
  });
});

describe('configurationChecks', () => {
  const full = {
    EMAIL_FROM: 'noreply@uc.org',
    EMAIL_REPLY_TO: 'hello@uc.org',
    AWS_REGION: 'us-west-1',
    AWS_ACCESS_KEY_ID: 'k',
    AWS_SECRET_ACCESS_KEY: 's',
    SES_CONFIGURATION_SET: 'ats',
    SES_SNS_TOPIC_ARN: 'arn:aws:sns:us-west-1:1:ats',
    UNSUBSCRIBE_SECRET: 'x',
  };

  it('passes a complete setup', () => {
    expect(worstStatus(configurationChecks(full).map((c) => c.status))).toBe('ok');
  });

  it('fails without a From address or region, and warns without event feedback', () => {
    const checks = byKey(configurationChecks({ ...full, EMAIL_FROM: '', AWS_REGION: '', SES_CONFIGURATION_SET: '' }));
    expect(checks.from.status).toBe(STATUS.FAIL);
    expect(checks.region.status).toBe(STATUS.FAIL);
    expect(checks.configSet.status).toBe(STATUS.WARN);
  });

  it('never echoes a secret', () => {
    const text = JSON.stringify(configurationChecks({ ...full, AWS_SECRET_ACCESS_KEY: 'hunter2-secret', UNSUBSCRIBE_SECRET: 'sshh-value' }));
    expect(text).not.toContain('hunter2-secret');
    expect(text).not.toContain('sshh-value');
  });
});

describe('interpretAccount', () => {
  const healthy = {
    SendingEnabled: true,
    ProductionAccessEnabled: true,
    EnforcementStatus: 'HEALTHY',
    SendQuota: { Max24HourSend: 50000, MaxSendRate: 14, SentLast24Hours: 120 },
  };

  it('passes a healthy production account', () => {
    expect(worstStatus(interpretAccount(healthy).map((c) => c.status))).toBe('ok');
  });

  it('fails the sandbox, since candidates would get nothing', () => {
    expect(byKey(interpretAccount({ ...healthy, ProductionAccessEnabled: false })).production.status).toBe(STATUS.FAIL);
  });

  it('warns on probation and fails on shutdown', () => {
    expect(byKey(interpretAccount({ ...healthy, EnforcementStatus: 'PROBATION' })).enforcement.status).toBe(STATUS.WARN);
    expect(byKey(interpretAccount({ ...healthy, EnforcementStatus: 'SHUTDOWN' })).enforcement.status).toBe(STATUS.FAIL);
  });

  it('warns as the daily quota runs out', () => {
    const near = { ...healthy, SendQuota: { ...healthy.SendQuota, SentLast24Hours: 40000 } };
    expect(byKey(interpretAccount(near)).quota.status).toBe(STATUS.WARN);
  });
});

describe('interpretIdentity', () => {
  it('passes a verified, DKIM-signed domain', () => {
    const checks = byKey(interpretIdentity({ VerifiedForSendingStatus: true, DkimAttributes: { Status: 'SUCCESS' } }, 'uc.org'));
    expect(checks.identity.status).toBe(STATUS.OK);
    expect(checks.dkim.status).toBe(STATUS.OK);
    expect(checks.mailFrom.status).toBe(STATUS.INFO);
  });

  it('fails an unverified identity and failed DKIM', () => {
    const checks = byKey(interpretIdentity({ VerifiedForSendingStatus: false, DkimAttributes: { Status: 'FAILED' } }, 'uc.org'));
    expect(checks.identity.status).toBe(STATUS.FAIL);
    expect(checks.dkim.status).toBe(STATUS.FAIL);
  });
});

describe('interpretEventDestinations', () => {
  const TOPIC = 'arn:aws:sns:us-west-1:1:ats';
  const dest = (overrides = {}) => ({
    Name: 'to-ats',
    Enabled: true,
    MatchingEventTypes: ['SEND', 'DELIVERY', 'BOUNCE', 'COMPLAINT'],
    SnsDestination: { TopicArn: TOPIC },
    ...overrides,
  });

  it('passes a destination on the webhook topic with the needed events', () => {
    expect(interpretEventDestinations([dest()], TOPIC).status).toBe(STATUS.OK);
  });

  it('fails when the destination publishes somewhere the webhook does not accept', () => {
    const result = interpretEventDestinations([dest({ SnsDestination: { TopicArn: 'arn:other' } })], TOPIC);
    expect(result.status).toBe(STATUS.FAIL);
    expect(result.detail).toContain('arn:other');
  });

  it('fails when there is no SNS destination, or it is disabled', () => {
    expect(interpretEventDestinations([], TOPIC).status).toBe(STATUS.FAIL);
    expect(interpretEventDestinations([dest({ Enabled: false })], TOPIC).status).toBe(STATUS.FAIL);
  });

  it('warns when bounces or complaints are not published', () => {
    const result = interpretEventDestinations([dest({ MatchingEventTypes: ['DELIVERY'] })], TOPIC);
    expect(result.status).toBe(STATUS.WARN);
    expect(result.detail).toMatch(/bounce, complaint/);
  });
});

describe('sesChecks', () => {
  const env = { AWS_REGION: 'us-west-1', EMAIL_FROM: 'noreply@uc.org' };

  it('reports a read-only permission gap as unknown, not broken', async () => {
    const denied = Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
    const client = { send: vi.fn().mockRejectedValue(denied) };
    const checks = await sesChecks({ env, client });
    expect(checks.map((c) => c.status)).toEqual([STATUS.UNKNOWN, STATUS.UNKNOWN]);
    expect(checks[0].detail).toContain('ses:GetAccount');
  });

  const sesWith = (identities) => ({
    send: vi.fn(async (command) => {
      if (command.constructor.name === 'GetAccountCommand') {
        return { SendingEnabled: true, ProductionAccessEnabled: true, EnforcementStatus: 'HEALTHY' };
      }
      const identity = identities[command.input.EmailIdentity];
      if (!identity) throw Object.assign(new Error('nf'), { name: 'NotFoundException' });
      return identity;
    }),
  });

  it('reports on the address identity when there is one, since SES sends with it', async () => {
    const client = sesWith({
      'uc.org': { VerifiedForSendingStatus: true, DkimAttributes: { Status: 'SUCCESS' } },
      'noreply@uc.org': { VerifiedForSendingStatus: false, DkimAttributes: { Status: 'FAILED' } },
    });
    const checks = byKey(await sesChecks({ env, client }));
    expect(checks.identity.status).toBe(STATUS.FAIL);
    expect(checks.identity.detail).toContain('noreply@uc.org');
  });

  it('falls back to the domain identity when the address is not one', async () => {
    const client = sesWith({ 'uc.org': { VerifiedForSendingStatus: true, DkimAttributes: { Status: 'SUCCESS' } } });
    const checks = byKey(await sesChecks({ env, client }));
    expect(checks.identity.status).toBe(STATUS.OK);
    expect(checks.identity.detail).toContain('uc.org is verified');
  });
});

describe('DNS', () => {
  it('reads SPF', () => {
    expect(interpretSpf([]).status).toBe(STATUS.INFO);
    expect(interpretSpf(['v=spf1 include:amazonses.com ~all']).status).toBe(STATUS.OK);
    expect(interpretSpf(['v=spf1 -all', 'v=spf1 ~all']).status).toBe(STATUS.FAIL);
    expect(interpretSpf(['v=spf1 +all']).status).toBe(STATUS.FAIL);
    expect(interpretSpf(['google-site-verification=abc']).status).toBe(STATUS.INFO);
  });

  it('reads DMARC', () => {
    expect(interpretDmarc([]).status).toBe(STATUS.WARN);
    expect(interpretDmarc(['v=DMARC1; p=none; rua=mailto:x@uc.org']).status).toBe(STATUS.OK);
    expect(interpretDmarc(['v=DMARC1; rua=mailto:x@uc.org']).status).toBe(STATUS.FAIL);
  });

  it('turns lookups into checks, treating a missing record as missing and a timeout as unknown', async () => {
    const nodata = Object.assign(new Error('no data'), { code: 'ENODATA' });
    const timeout = Object.assign(new Error('timed out'), { code: 'ETIMEOUT' });
    const resolver = {
      resolveTxt: vi.fn(async (name) => {
        if (name === 'uc.org') return [['v=spf1 ', 'include:amazonses.com ~all']];
        throw timeout;
      }),
      resolveMx: vi.fn().mockRejectedValue(nodata),
    };
    const checks = byKey(await dnsChecks({ env: { EMAIL_FROM: 'noreply@uc.org' }, resolver }));
    expect(checks.spf.status).toBe(STATUS.OK);
    expect(checks.spf.detail).toBe('v=spf1 include:amazonses.com ~all');
    expect(checks.dmarc.status).toBe(STATUS.UNKNOWN);
    expect(checks.mx.status).toBe(STATUS.WARN);

    const elsewhere = byKey(await dnsChecks({ env: { EMAIL_FROM: 'noreply@uc.org', EMAIL_REPLY_TO: 'team@gmail.com' }, resolver }));
    expect(elsewhere.mx.status).toBe(STATUS.INFO);
  });
});

describe('summarizeDelivery', () => {
  it('does not grade rates on too few sends', () => {
    const { checks } = summarizeDelivery({ DELIVERED: 9, BOUNCED: 1 });
    expect(byKey(checks).bounceRate.status).toBe(STATUS.INFO);
  });

  it('grades bounce and complaint rates against the SES review levels', () => {
    const warn = byKey(summarizeDelivery({ DELIVERED: 970, BOUNCED: 30 }).checks);
    expect(warn.bounceRate.status).toBe(STATUS.WARN);
    const fail = byKey(summarizeDelivery({ DELIVERED: 998, COMPLAINED: 2 }).checks);
    expect(fail.complaintRate.status).toBe(STATUS.FAIL);
  });

  it('counts interrupted sends as not sent, so it never claims SES accepted everything', () => {
    const { checks, totals } = summarizeDelivery({ DELIVERED: 100 }, { interrupted: 2 });
    expect(totals.interrupted).toBe(2);
    expect(byKey(checks).sendFailures.status).toBe(STATUS.WARN);
    expect(byKey(checks).sendFailures.detail).toBe('2 sends interrupted before SES answered.');
  });

  it('still says SES accepted every message when nothing failed or was interrupted', () => {
    const { checks } = summarizeDelivery({ DELIVERED: 100 });
    expect(byKey(checks).sendFailures.detail).toBe('SES accepted every message.');
  });

  it('leaves FAILED out of the rates SES judges', () => {
    const { totals } = summarizeDelivery({ DELIVERED: 100, FAILED: 5 });
    expect(totals.attempted).toBe(100);
    expect(totals.failed).toBe(5);
  });

  it('flags delivery reports that never arrive', () => {
    const stuck = byKey(summarizeDelivery({ SENT: 40 }, { awaitingFeedback: 40, eligibleForFeedback: 40 }).checks);
    expect(stuck.feedback.status).toBe(STATUS.FAIL);
    const fine = byKey(summarizeDelivery({ DELIVERED: 40 }, { awaitingFeedback: 0, eligibleForFeedback: 40 }).checks);
    expect(fine.feedback.status).toBe(STATUS.OK);
    const off = byKey(summarizeDelivery({ SENT: 40 }, { feedbackConfigured: false }).checks);
    expect(off.feedback.status).toBe(STATUS.INFO);
  });
});

describe('deliveryReport', () => {
  it('reads only email from the window and counts active suppressions', async () => {
    const client = {
      communicationLog: {
        groupBy: vi.fn().mockResolvedValue([{ status: 'DELIVERED', _count: { _all: 60 } }]),
        count: vi.fn().mockResolvedValue(0),
        findMany: vi.fn().mockResolvedValue([]),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      emailSuppression: {
        groupBy: vi.fn().mockResolvedValue([{ reason: 'BOUNCED', _count: { _all: 3 } }]),
      },
    };
    const now = new Date('2026-09-26T12:00:00Z');
    const report = await deliveryReport({ days: 7, now, client, env: {} });

    const where = client.communicationLog.groupBy.mock.calls[0][0].where;
    expect(where.channel).toBe('email');
    expect(where.sentAt.gte).toEqual(new Date('2026-09-19T12:00:00Z'));
    expect(client.emailSuppression.groupBy.mock.calls[0][0].where).toEqual({ resubscribedAt: null });
    // Delivery-report coverage counts only mail SES accepted, never a mailto: row.
    for (const [{ where: w }] of client.communicationLog.count.mock.calls.slice(0, 2)) {
      expect(w.providerMessageId).toEqual({ not: null });
    }
    // Interrupted claims never reached SES, so that count is the one without a provider id.
    expect(client.communicationLog.count.mock.calls[2][0].where).toEqual({
      channel: 'email',
      status: 'SENDING',
      sentAt: { gte: new Date('2026-09-19T12:00:00Z'), lt: new Date('2026-09-26T11:50:00Z') },
    });
    expect(client.communicationLog.count.mock.calls[1][0].where.status).toEqual({ notIn: ['FAILED', 'OPENED'] });
    expect(report.totals.delivered).toBe(60);
    expect(report.suppressions).toEqual({ BOUNCED: 3 });
  });
});

describe('emailHealthReport', () => {
  it('still answers the SES and DNS checks when the database is down', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const down = new Error("Can't reach database server");
    prisma.communicationLog.groupBy.mockRejectedValue(down);
    prisma.communicationLog.count.mockRejectedValue(down);
    prisma.communicationLog.findMany.mockRejectedValue(down);
    prisma.communicationLog.findFirst.mockRejectedValue(down);
    prisma.emailSuppression.groupBy.mockRejectedValue(down);

    const env = { EMAIL_FROM: 'noreply@uc.org', AWS_REGION: 'us-west-1' };
    const ses = { send: vi.fn().mockResolvedValue({ SendingEnabled: true, ProductionAccessEnabled: true, EnforcementStatus: 'HEALTHY' }) };
    const resolver = { resolveTxt: vi.fn().mockResolvedValue([]), resolveMx: vi.fn().mockResolvedValue([{ exchange: 'mx.uc.org', priority: 1 }]) };

    const report = await emailHealthReport({ env, ses, resolver });

    expect(report.delivery).toBeNull();
    expect(report.recentTests).toEqual([]);
    const sections = Object.fromEntries(report.sections.map((s) => [s.key, s]));
    expect(byKey(sections.ses.checks).production.status).toBe(STATUS.OK);
    expect(byKey(sections.dns.checks).mx.status).toBe(STATUS.OK);
    expect(sections.delivery.checks[0].status).toBe(STATUS.UNKNOWN);
  });
});
