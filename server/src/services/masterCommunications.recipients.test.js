// Who a master communication actually reaches.
//
// The rule worth pinning down is that a send never reaches someone who has left.
// Deactivation is how this app records that, and the recipient query used to
// ignore it entirely: a send to "members" resolved all 55 member accounts
// rather than the 45 active ones, putting org mail in front of ten people who
// were no longer part of the organization.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { resolveRecipients } from './masterCommunications.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findMany: vi.fn() },
    application: { findMany: vi.fn() },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findMany.mockResolvedValue([]);
});

const whereOf = () => prisma.user.findMany.mock.calls[0][0].where;

describe('members', () => {
  it('asks only for active accounts', async () => {
    await resolveRecipients({ audience: 'members' });
    expect(whereOf()).toEqual({ role: { in: ['MEMBER'] }, isActive: true });
  });

  it('keeps the active filter when roles are chosen explicitly', async () => {
    await resolveRecipients({ audience: 'members', filters: { roles: ['MEMBER', 'ADMIN'] } });
    expect(whereOf()).toMatchObject({ role: { in: ['MEMBER', 'ADMIN'] }, isActive: true });
  });

  it('treats the users audience the same way', async () => {
    await resolveRecipients({ audience: 'users', filters: { roles: ['USER'] } });
    expect(whereOf()).toMatchObject({ isActive: true });
  });

  it('returns the recipients the query produced', async () => {
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1', email: 'a@uc.org', fullName: 'Active Member', role: 'MEMBER' },
    ]);
    const recipients = await resolveRecipients({ audience: 'members' });
    expect(recipients).toEqual([
      { id: 'u1', email: 'a@uc.org', fullName: 'Active Member', audience: 'user', role: 'MEMBER' },
    ]);
  });
});

describe('admins', () => {
  it('asks only for active accounts', async () => {
    await resolveRecipients({ audience: 'admins' });
    expect(whereOf()).toEqual({ role: 'ADMIN', isActive: true });
  });
});

describe('an unknown audience', () => {
  it('is refused rather than silently reaching nobody', async () => {
    await expect(resolveRecipients({ audience: 'everyone' })).rejects.toThrow(/Unsupported audience/);
  });
});
