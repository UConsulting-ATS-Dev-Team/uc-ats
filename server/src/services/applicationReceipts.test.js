import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { sendApplicationReceivedEmail } from './emailNotifications.js';
import { planApplicationReceipts, sendApplicationReceipts } from './applicationReceipts.js';

vi.mock('../prismaClient.js', () => {
  const client = {
    application: { findMany: vi.fn() },
    communicationLog: { findMany: vi.fn() },
    $queryRaw: vi.fn(),
    $transaction: vi.fn((fn) => fn(client)),
  };
  return { default: client };
});
vi.mock('./emailNotifications.js', () => ({ sendApplicationReceivedEmail: vi.fn() }));

const cycle = { id: 'cycle-1', name: 'Fall 2026' };

const app = (email, overrides = {}) => ({
  email,
  firstName: 'Maria',
  lastName: 'Lopez',
  status: 'SUBMITTED',
  currentRound: '1',
  submittedAt: new Date('2026-09-20T00:00:00Z'),
  ...overrides,
});

let logRows;

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  logRows = [];
  prisma.application.findMany.mockResolvedValue([]);
  prisma.communicationLog.findMany.mockImplementation(async () => logRows);
  prisma.$queryRaw.mockResolvedValue([{ locked: true }]);
  prisma.$transaction.mockImplementation((fn) => fn(prisma));
  // Like sendEmail: the log row exists by the time the send returns.
  sendApplicationReceivedEmail.mockImplementation(async (recipient) => {
    logRows.push({ recipient, status: 'SENT' });
    return { success: true };
  });
});

describe('planApplicationReceipts', () => {
  it('owes one receipt per person, counting both UCLA spellings as one', async () => {
    prisma.application.findMany.mockResolvedValue([
      app('maria@ucla.edu'),
      app('Maria@g.ucla.edu', { submittedAt: new Date('2026-09-21T00:00:00Z') }),
    ]);

    const { toSend } = await planApplicationReceipts({ cycle });

    expect(toSend).toEqual([{ key: expect.any(String), email: 'Maria@g.ucla.edu', name: 'Maria Lopez' }]);
  });

  it('does not let an old decided application hide a newer waiting one', async () => {
    prisma.application.findMany.mockResolvedValue([
      app('maria@ucla.edu', { status: 'REJECTED' }),
      app('maria@ucla.edu', { submittedAt: new Date('2026-09-21T00:00:00Z') }),
    ]);

    const { toSend } = await planApplicationReceipts({ cycle });

    expect(toSend.map((p) => p.email)).toEqual(['maria@ucla.edu']);
  });

  it('skips people already decided, already sent, or failed three times', async () => {
    prisma.application.findMany.mockResolvedValue([
      app('advanced@ucla.edu', { currentRound: '2' }),
      app('rejected@ucla.edu', { status: 'REJECTED' }),
      app('sent@ucla.edu'),
      app('bounced@ucla.edu'),
      app('owed@ucla.edu'),
    ]);
    logRows = [
      { recipient: 'SENT@ucla.edu', status: 'DELIVERED' },
      ...Array.from({ length: 3 }, () => ({ recipient: 'bounced@ucla.edu', status: 'FAILED' })),
      { recipient: 'owed@ucla.edu', status: 'FAILED' },
    ];

    const { toSend, skipped } = await planApplicationReceipts({ cycle });

    expect(toSend.map((p) => p.email)).toEqual(['owed@ucla.edu']);
    expect(Object.fromEntries(skipped.map((s) => [s.email, s.reason]))).toEqual({
      'advanced@ucla.edu': 'already decided (status SUBMITTED, round 2)',
      'rejected@ucla.edu': 'already decided (status REJECTED, round 1)',
      'sent@ucla.edu': 'already sent',
      'bounced@ucla.edu': 'gave up after 3 failed attempts',
    });
  });

  it('limits to applications submitted since a date when given one', async () => {
    const since = new Date('2026-09-25T00:00:00Z');
    await planApplicationReceipts({ cycle, since });

    expect(prisma.application.findMany.mock.calls[0][0].where).toEqual({
      cycleId: 'cycle-1',
      submittedAt: { gte: since },
    });
  });
});

describe('sendApplicationReceipts', () => {
  it('sends what is owed and nothing on a second run', async () => {
    prisma.application.findMany.mockResolvedValue([app('maria@ucla.edu')]);

    const first = await sendApplicationReceipts({ cycle });
    const second = await sendApplicationReceipts({ cycle });

    expect(first.sent).toBe(1);
    expect(second.sent).toBe(0);
    expect(sendApplicationReceivedEmail).toHaveBeenCalledTimes(1);
    expect(sendApplicationReceivedEmail).toHaveBeenCalledWith('maria@ucla.edu', 'Maria Lopez', 'Fall 2026', { cycleId: 'cycle-1' });
  });

  it('sends nothing when another sender holds the lock', async () => {
    prisma.application.findMany.mockResolvedValue([app('maria@ucla.edu')]);
    prisma.$queryRaw.mockResolvedValue([{ locked: false }]);

    const result = await sendApplicationReceipts({ cycle });

    expect(result.sent).toBe(0);
    expect(sendApplicationReceivedEmail).not.toHaveBeenCalled();
  });

  it('re-reads the log under the lock, so a send that landed after planning is not repeated', async () => {
    prisma.application.findMany.mockResolvedValue([app('maria@ucla.edu')]);
    prisma.communicationLog.findMany
      .mockImplementationOnce(async () => [])
      .mockImplementationOnce(async () => [{ recipient: 'maria@ucla.edu', status: 'SENT' }]);

    const result = await sendApplicationReceipts({ cycle });

    expect(result.sent).toBe(0);
    expect(sendApplicationReceivedEmail).not.toHaveBeenCalled();
  });

  it('reports a failed send and carries on to the next person', async () => {
    prisma.application.findMany.mockResolvedValue([app('bad@ucla.edu'), app('good@ucla.edu')]);
    sendApplicationReceivedEmail.mockImplementation(async (recipient) => {
      if (recipient === 'bad@ucla.edu') return { success: false, error: 'Address rejected' };
      return { success: true };
    });

    const result = await sendApplicationReceipts({ cycle });

    expect(result.sent).toBe(1);
    expect(result.failed).toEqual([expect.objectContaining({ email: 'bad@ucla.edu', error: 'Address rejected' })]);
  });
});
