import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { resolveSignupContacts, logSignupContact } from './meetingSignupContacts.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findMany: vi.fn() },
    candidate: { findMany: vi.fn() },
    application: { findMany: vi.fn() },
    communicationLog: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
  },
}));

const signups = [
  { id: 'su-1', fullName: 'Jordan Rivera', email: 'Jordan@UCLA.edu' },
  { id: 'su-2', fullName: 'Sam Patel', email: 'sam@ucla.edu' },
];

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findMany.mockResolvedValue([]);
  prisma.candidate.findMany.mockResolvedValue([]);
  prisma.application.findMany.mockResolvedValue([]);
});

describe('resolveSignupContacts', () => {
  it('finds a number on the latest application, matching email case-insensitively', async () => {
    prisma.application.findMany.mockResolvedValue([
      { email: 'jordan@ucla.edu', phoneNumber: '310-555-1234' },
      { email: 'jordan@ucla.edu', phoneNumber: '310-555-0000' },
    ]);

    const contacts = await resolveSignupContacts(signups);
    expect(contacts).toEqual([
      { signupId: 'su-1', fullName: 'Jordan Rivera', email: 'Jordan@UCLA.edu', phoneNumber: '+13105551234' },
      { signupId: 'su-2', fullName: 'Sam Patel', email: 'sam@ucla.edu', phoneNumber: null },
    ]);
  });

  it('prefers the account number, then onboarding, then the application', async () => {
    prisma.user.findMany.mockResolvedValue([{ email: 'jordan@ucla.edu', phoneNumber: '+13105550001' }]);
    prisma.candidate.findMany.mockResolvedValue([
      { email: 'jordan@ucla.edu', onboarding: { phoneNumber: '3105550002' } },
      { email: 'sam@ucla.edu', onboarding: { phoneNumber: '3105550003' } },
    ]);
    prisma.application.findMany.mockResolvedValue([{ email: 'sam@ucla.edu', phoneNumber: '3105550004' }]);

    const contacts = await resolveSignupContacts(signups);
    expect(contacts.map((c) => c.phoneNumber)).toEqual(['+13105550001', '+13105550003']);
  });

  it('skips a number that does not normalize rather than guessing', async () => {
    prisma.application.findMany.mockResolvedValue([
      { email: 'jordan@ucla.edu', phoneNumber: '555-1234' },
      { email: 'jordan@ucla.edu', phoneNumber: '(310) 555-9999' },
    ]);

    const [jordan] = await resolveSignupContacts(signups);
    expect(jordan.phoneNumber).toBe('+13105559999');
  });

  it('never reads a sealed candidate\'s onboarding or applications', async () => {
    await resolveSignupContacts(signups);
    expect(prisma.candidate.findMany.mock.calls[0][0].where.recordsLockedAt).toBeNull();
    expect(prisma.application.findMany.mock.calls[0][0].where.NOT).toEqual({
      candidate: { recordsLockedAt: { not: null } },
    });
  });

  it('asks nothing of the database for an empty slot', async () => {
    expect(await resolveSignupContacts([])).toEqual([]);
    expect(prisma.application.findMany).not.toHaveBeenCalled();
  });
});

describe('logSignupContact', () => {
  const contacts = [
    { signupId: 'su-1', fullName: 'Jordan Rivera', email: 'jordan@ucla.edu', phoneNumber: '+13105551234' },
    { signupId: 'su-2', fullName: 'Sam Patel', email: 'sam@ucla.edu', phoneNumber: null },
  ];

  it('logs an iMessage as OPENED for each person who had a number', async () => {
    await logSignupContact({ channel: 'imessage', body: 'Hi!', contacts, triggeredById: 'host-1' });

    const { data } = prisma.communicationLog.createMany.mock.calls[0][0];
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({
      channel: 'imessage',
      category: 'MEETING',
      trigger: 'MANUAL',
      status: 'OPENED',
      recipient: '+13105551234',
      recipientName: 'Jordan Rivera',
      triggeredById: 'host-1',
    });
  });

  it('logs an email for everyone', async () => {
    await logSignupContact({ channel: 'email', body: 'Hi!', contacts, triggeredById: 'host-1' });
    const { data } = prisma.communicationLog.createMany.mock.calls[0][0];
    expect(data.map((r) => r.recipient)).toEqual(['jordan@ucla.edu', 'sam@ucla.edu']);
  });

  it('refuses a channel it does not know', async () => {
    await expect(logSignupContact({ channel: 'slack', contacts })).rejects.toMatchObject({ status: 400 });
  });
});
