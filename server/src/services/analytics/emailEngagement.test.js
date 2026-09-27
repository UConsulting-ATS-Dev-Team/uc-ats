import { describe, it, expect, vi } from 'vitest';

import { isSuspectedBot, linkOrphanEngagement, recordEmailEngagement, stripQuery } from './emailEngagement.js';

vi.mock('../../prismaClient.js', () => ({ default: {} }));
vi.mock('./log.js', () => ({ logError: vi.fn() }));

const HUMAN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15';
const SENT = '2026-09-27T10:00:00.000Z';

describe('isSuspectedBot', () => {
  it('trusts a browser clicking a while after delivery', () => {
    expect(isSuspectedBot({ userAgent: HUMAN, at: '2026-09-27T10:04:00Z', sentAt: SENT })).toBe(false);
  });

  it.each([
    ['no user agent', null, '2026-09-27T10:04:00Z'],
    ['not a browser', 'python-requests/2.31', '2026-09-27T10:04:00Z'],
    ['a named scanner', 'Mozilla/5.0 (compatible; Microsoft SafeLinks)', '2026-09-27T10:04:00Z'],
    ['faster than a person reads', HUMAN, '2026-09-27T10:00:01Z'],
  ])('flags %s', (_, userAgent, at) => {
    expect(isSuspectedBot({ userAgent, at, sentAt: SENT })).toBe(true);
  });
});

describe('stripQuery', () => {
  it('keeps origin and path only', () => {
    expect(stripQuery('https://ats.test/interview-signup?token=abc#x')).toBe('https://ats.test/interview-signup');
    expect(stripQuery(null)).toBeNull();
  });
});

describe('linkOrphanEngagement', () => {
  it('reports how many clicks it attached, and never throws', async () => {
    await expect(linkOrphanEngagement({ $executeRaw: vi.fn(async () => 3) })).resolves.toBe(3);
    await expect(
      linkOrphanEngagement({
        $executeRaw: vi.fn(async () => {
          throw new Error('no table');
        }),
      })
    ).resolves.toBe(0);
  });
});

describe('recordEmailEngagement', () => {
  const client = () => ({
    communicationLog: { findFirst: vi.fn(async () => ({ id: 'log-1', category: 'INTERVIEW_SLOT' })) },
    emailEngagementEvent: { createMany: vi.fn(async () => ({ count: 1 })) },
  });
  const args = (link = 'https://ats.test/x?token=1') => ({
    sesId: 'ses-9',
    event: { mail: { timestamp: SENT, tags: { category: ['OTHER'] } } },
    outcome: {
      recipients: ['Joe@UCLA.edu'],
      engagement: { kind: 'CLICK', link, userAgent: HUMAN, ip: '1.2.3.4', at: '2026-09-27T10:04:00Z' },
    },
  });

  it('links the event to its log row and stores the link without its query', async () => {
    const c = client();
    await recordEmailEngagement(args(), c);
    const [{ data, skipDuplicates }] = c.emailEngagementEvent.createMany.mock.calls[0];
    expect(skipDuplicates).toBe(true);
    expect(data[0]).toMatchObject({
      kind: 'CLICK',
      communicationLogId: 'log-1',
      category: 'INTERVIEW_SLOT',
      recipient: 'joe@ucla.edu',
      link: 'https://ats.test/x',
      suspectedBot: false,
    });
  });

  it('gives a redelivered notification the same id, so it counts once', async () => {
    const c = client();
    await recordEmailEngagement(args(), c);
    await recordEmailEngagement(args(), c);
    const [first, second] = c.emailEngagementEvent.createMany.mock.calls.map(([a]) => a.data[0].id);
    expect(first).toBe(second);
  });

  it('falls back to the SES category tag when no log row matches', async () => {
    const c = client();
    c.communicationLog.findFirst.mockResolvedValue(null);
    await recordEmailEngagement(args(), c);
    expect(c.emailEngagementEvent.createMany.mock.calls[0][0].data[0]).toMatchObject({ communicationLogId: null, category: 'OTHER' });
  });

  it('never throws', async () => {
    const c = client();
    c.emailEngagementEvent.createMany.mockRejectedValue(new Error('no table'));
    await expect(recordEmailEngagement(args(), c)).resolves.toBe(0);
  });
});
