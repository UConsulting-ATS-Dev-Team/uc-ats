// Unsubscribes. What matters: a link can only ever unsubscribe the address it
// was sent to, staff are never held back, and the first reason for an opt-out
// is the one that is kept.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import {
  applySuppressions,
  isSuppressed,
  readUnsubscribeToken,
  resubscribeEmail,
  suppressEmail,
  unsubscribeToken,
  unsubscribeUrls,
} from './emailSuppression.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    emailSuppression: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), count: vi.fn(), updateMany: vi.fn() },
    user: { findMany: vi.fn() },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  prisma.emailSuppression.findMany.mockResolvedValue([]);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.emailSuppression.upsert.mockImplementation(async ({ create }) => create);
});

describe('tokens', () => {
  it('round-trips, lowercasing the address', () => {
    expect(readUnsubscribeToken(unsubscribeToken('Joe@UCLA.edu'))).toBe('joe@ucla.edu');
  });

  it('refuses a token whose address was swapped', () => {
    const [, sig] = unsubscribeToken('joe@ucla.edu').split('.');
    const forged = `${Buffer.from('victim@ucla.edu').toString('base64url')}.${sig}`;
    expect(readUnsubscribeToken(forged)).toBeNull();
  });

  it('refuses garbage', () => {
    for (const t of [undefined, '', 'abc', 'a.b.c', '.', 'x.']) expect(readUnsubscribeToken(t)).toBeNull();
  });

  it('points the footer at a page and the header at the one-click endpoint', () => {
    const { page, oneClick } = unsubscribeUrls('joe@ucla.edu');
    expect(page).toMatch(/\/unsubscribe\?t=/);
    expect(oneClick).toMatch(/\/api\/unsubscribe\/one-click\?t=/);
  });
});

describe('suppressEmail', () => {
  it('keeps the original reason when the address is already opted out', async () => {
    const existing = { email: 'joe@ucla.edu', reason: 'UNSUBSCRIBED', resubscribedAt: null };
    prisma.emailSuppression.findUnique.mockResolvedValue(existing);
    const row = await suppressEmail({ email: 'joe@ucla.edu', reason: 'BOUNCED', source: 'SES' });
    expect(row).toBe(existing);
    expect(prisma.emailSuppression.upsert).not.toHaveBeenCalled();
  });

  it('opts out again someone who had resubscribed', async () => {
    prisma.emailSuppression.findUnique.mockResolvedValue({ email: 'joe@ucla.edu', resubscribedAt: new Date() });
    await suppressEmail({ email: 'Joe@ucla.edu', reason: 'UNSUBSCRIBED', source: 'LINK' });
    expect(prisma.emailSuppression.upsert.mock.calls[0][0]).toMatchObject({
      where: { email: 'joe@ucla.edu' },
      update: { reason: 'UNSUBSCRIBED', source: 'LINK', resubscribedAt: null },
    });
  });

  it('refuses an unknown reason', async () => {
    await expect(suppressEmail({ email: 'a@b.co', reason: 'BORED', source: 'LINK' })).rejects.toThrow(/Unknown/);
  });
});

describe('applySuppressions', () => {
  const people = [
    { id: '1', email: 'student@ucla.edu' },
    { id: '2', email: 'gone@ucla.edu' },
    { id: '3', email: 'member@uc.org' },
  ];

  it('holds back opted-out non-staff and tags everyone else', async () => {
    prisma.emailSuppression.findMany.mockResolvedValue([{ email: 'gone@ucla.edu' }, { email: 'member@uc.org' }]);
    prisma.user.findMany.mockResolvedValue([{ email: 'member@uc.org' }]);

    const { deliver, skipped } = await applySuppressions(people);

    expect(skipped.map((r) => r.email)).toEqual(['gone@ucla.edu']);
    // A member who once unsubscribed still gets staff mail, and without a footer.
    expect(deliver).toEqual([
      expect.objectContaining({ email: 'student@ucla.edu', marketing: true }),
      expect.objectContaining({ email: 'member@uc.org', marketing: false }),
    ]);
  });

  it('treats g.ucla.edu and ucla.edu as one inbox', async () => {
    prisma.emailSuppression.findMany.mockResolvedValue([{ email: 'gone@g.ucla.edu' }]);
    prisma.user.findMany.mockResolvedValue([{ email: 'staff@g.ucla.edu' }]);

    const { deliver, skipped } = await applySuppressions([
      { id: '1', email: 'gone@ucla.edu' },
      { id: '2', email: 'staff@ucla.edu' },
    ]);

    expect(skipped.map((r) => r.email)).toEqual(['gone@ucla.edu']);
    expect(deliver).toEqual([expect.objectContaining({ email: 'staff@ucla.edu', marketing: false })]);
    expect(prisma.emailSuppression.findMany.mock.calls[0][0].where.email.in).toEqual(
      expect.arrayContaining(['gone@ucla.edu', 'gone@g.ucla.edu'])
    );
  });

  it('asks only about active staff', async () => {
    await applySuppressions(people);
    expect(prisma.user.findMany.mock.calls[0][0].where).toMatchObject({ role: { in: ['MEMBER', 'ADMIN'] }, isActive: true });
  });
});

describe('the unsubscribe page and the other UCLA spelling', () => {
  it('reports an opt-out stored under the twin spelling, as delivery does', async () => {
    prisma.emailSuppression.count.mockResolvedValue(1);
    expect(await isSuppressed('joe@ucla.edu')).toBe(true);
    expect(prisma.emailSuppression.count.mock.calls[0][0].where).toEqual({
      email: { in: ['joe@ucla.edu', 'joe@g.ucla.edu'] },
      resubscribedAt: null,
    });
  });

  it('lifts the opt-out under both spellings', async () => {
    prisma.emailSuppression.updateMany.mockResolvedValue({ count: 1 });
    expect(await resubscribeEmail('joe@ucla.edu')).toBe(true);
    expect(prisma.emailSuppression.updateMany.mock.calls[0][0].where).toEqual({
      email: { in: ['joe@ucla.edu', 'joe@g.ucla.edu'] },
      resubscribedAt: null,
    });
  });
});
