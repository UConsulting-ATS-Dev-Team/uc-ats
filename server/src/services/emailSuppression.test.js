// Unsubscribes. What matters: a link can only ever unsubscribe the address it
// was sent to, staff are never held back, and the first reason for an opt-out
// is the one that is kept.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import {
  applySuppressions,
  suppressionStatus,
  readUnsubscribeToken,
  resubscribeEmail,
  suppressEmail,
  unsubscribeToken,
  unsubscribeUrls,
} from './emailSuppression.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    emailSuppression: { findUnique: vi.fn(), findMany: vi.fn(), upsert: vi.fn(), updateMany: vi.fn() },
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

  it('keeps the earlier detail when opting out again without a new one', async () => {
    prisma.emailSuppression.findUnique.mockResolvedValue({
      email: 'joe@ucla.edu', detail: '550 mailbox not found', resubscribedAt: new Date(),
    });
    await suppressEmail({ email: 'joe@ucla.edu', reason: 'ADMIN', source: 'ADMIN' });
    expect(prisma.emailSuppression.upsert.mock.calls[0][0].update.detail).toBe('550 mailbox not found');
  });

  it('replaces the earlier detail when a new one is given', async () => {
    prisma.emailSuppression.findUnique.mockResolvedValue({
      email: 'joe@ucla.edu', detail: 'old note', resubscribedAt: new Date(),
    });
    await suppressEmail({ email: 'joe@ucla.edu', reason: 'ADMIN', source: 'ADMIN', detail: 'asked again' });
    expect(prisma.emailSuppression.upsert.mock.calls[0][0].update.detail).toBe('asked again');
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
  it('reports an opt-out under the twin as one this link can lift', async () => {
    prisma.emailSuppression.findMany.mockResolvedValue([{ email: 'joe@g.ucla.edu', reason: 'UNSUBSCRIBED' }]);
    expect(await suppressionStatus('joe@ucla.edu')).toEqual({ unsubscribed: true, heldBack: false });
    expect(prisma.emailSuppression.findMany.mock.calls[0][0].where).toEqual({
      email: { in: ['joe@ucla.edu', 'joe@g.ucla.edu'] },
      resubscribedAt: null,
    });
  });

  it('reports a bounce on the twin as held back, which resubscribing cannot lift', async () => {
    prisma.emailSuppression.findMany.mockResolvedValue([{ email: 'joe@g.ucla.edu', reason: 'BOUNCED' }]);
    expect(await suppressionStatus('joe@ucla.edu')).toEqual({ unsubscribed: false, heldBack: true });
  });

  it("counts any block on the link's own address as liftable", async () => {
    prisma.emailSuppression.findMany.mockResolvedValue([{ email: 'joe@ucla.edu', reason: 'ADMIN' }]);
    expect(await suppressionStatus('joe@ucla.edu')).toEqual({ unsubscribed: true, heldBack: false });
  });

  it("lifts the person's own opt-out under the twin, never a bounce or admin block", async () => {
    prisma.emailSuppression.updateMany.mockResolvedValue({ count: 1 });
    expect(await resubscribeEmail('Joe@UCLA.edu')).toBe(true);
    expect(prisma.emailSuppression.updateMany.mock.calls[0][0].where).toEqual({
      resubscribedAt: null,
      OR: [{ email: 'joe@ucla.edu' }, { email: { in: ['joe@g.ucla.edu'] }, reason: 'UNSUBSCRIBED' }],
    });
  });

  it('clears only the address itself outside UCLA', async () => {
    prisma.emailSuppression.updateMany.mockResolvedValue({ count: 0 });
    await resubscribeEmail('joe@gmail.com');
    expect(prisma.emailSuppression.updateMany.mock.calls[0][0].where).toEqual({
      resubscribedAt: null,
      OR: [{ email: 'joe@gmail.com' }],
    });
  });
});
