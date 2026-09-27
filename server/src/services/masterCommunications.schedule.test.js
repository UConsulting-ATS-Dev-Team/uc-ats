// A scheduled send goes out once.
//
// The scheduler runs every minute on every server pointed at this database. A
// schedule used to stay PENDING for the whole send, so any send slower than a
// minute - or any second server - mailed the whole audience again. What stops
// that is the claim: only the run that moves the row PENDING -> SENDING sends.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { sendEmail } from './emailNotifications.js';
import { processScheduledMessages, cancelScheduledMessage } from './masterCommunications.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findMany: vi.fn() },
    application: { findMany: vi.fn() },
    messageLog: { create: vi.fn() },
    emailSuppression: { findMany: vi.fn() },
    messageSchedule: { findMany: vi.fn(), findUnique: vi.fn(), updateMany: vi.fn(), update: vi.fn() },
  },
}));

vi.mock('./emailNotifications.js', () => ({ sendEmail: vi.fn() }));
vi.mock('./slackService.js', () => ({ sendSlackMessage: vi.fn() }));
vi.mock('./communicationLog.js', () => ({ recordCommunications: vi.fn() }));

const schedule = (id) => ({
  id,
  audience: 'members',
  channel: 'email',
  filters: {},
  subject: 'Retreat',
  body: 'Hi {{firstName}}',
  sentBy: 'admin-1',
  cycleId: 'cycle-1',
  templateId: null,
  savedAudienceId: null,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  prisma.user.findMany.mockResolvedValue([
    { id: 'u1', email: 'a@uc.org', fullName: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', role: 'MEMBER' },
  ]);
  prisma.application.findMany.mockResolvedValue([]);
  prisma.messageLog.create.mockResolvedValue({ id: 'campaign-1' });
  prisma.emailSuppression.findMany.mockResolvedValue([]);
  prisma.messageSchedule.update.mockResolvedValue({});
  sendEmail.mockResolvedValue({ success: true, messageId: 'ses-1' });
});

describe('processScheduledMessages', () => {
  it('claims a due message before sending it, then marks it sent', async () => {
    prisma.messageSchedule.findMany.mockResolvedValue([schedule('s1')]);
    prisma.messageSchedule.updateMany.mockResolvedValue({ count: 1 });

    expect(await processScheduledMessages()).toBe(1);

    expect(prisma.messageSchedule.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', status: 'PENDING' },
      data: { status: 'SENDING' },
    });
    expect(prisma.messageSchedule.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      sendEmail.mock.invocationCallOrder[0]
    );
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(prisma.messageSchedule.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { status: 'SENT', messageLogId: 'campaign-1' },
    });
  });

  it('sends nothing for a message another run already claimed', async () => {
    // Read as PENDING, but a slower tick or another server got to it first.
    prisma.messageSchedule.findMany.mockResolvedValue([schedule('s1')]);
    prisma.messageSchedule.updateMany.mockResolvedValue({ count: 0 });

    expect(await processScheduledMessages()).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(prisma.messageSchedule.update).not.toHaveBeenCalled();
  });

  it('sends each message once when two runs read the same due list', async () => {
    // A database where the claim can land only once, as the conditional update
    // guarantees in Postgres.
    const status = { s1: 'PENDING' };
    prisma.messageSchedule.findMany.mockResolvedValue([schedule('s1')]);
    prisma.messageSchedule.updateMany.mockImplementation(async ({ where, data }) => {
      if (status[where.id] !== where.status) return { count: 0 };
      status[where.id] = data.status;
      return { count: 1 };
    });

    const [a, b] = await Promise.all([processScheduledMessages(), processScheduledMessages()]);

    expect(a + b).toBe(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('marks a message whose send throws as failed', async () => {
    prisma.messageSchedule.findMany.mockResolvedValue([schedule('s1')]);
    prisma.messageSchedule.updateMany.mockResolvedValue({ count: 1 });
    prisma.user.findMany.mockRejectedValue(new Error('connection reset'));

    await processScheduledMessages();

    expect(prisma.messageSchedule.update).toHaveBeenCalledWith({
      where: { id: 's1' },
      data: { status: 'FAILED' },
    });
  });
});

describe('cancelScheduledMessage', () => {
  it('cancels a pending message', async () => {
    prisma.messageSchedule.findUnique.mockResolvedValue({ id: 's1', status: 'PENDING' });
    prisma.messageSchedule.updateMany.mockResolvedValue({ count: 1 });

    expect(await cancelScheduledMessage({ id: 's1' })).toEqual({ id: 's1', status: 'CANCELLED' });
    expect(prisma.messageSchedule.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', status: 'PENDING' },
      data: { status: 'CANCELLED' },
    });
  });

  it('refuses once the scheduler has claimed it, rather than relabelling a send under way', async () => {
    prisma.messageSchedule.findUnique.mockResolvedValue({ id: 's1', status: 'PENDING' });
    prisma.messageSchedule.updateMany.mockResolvedValue({ count: 0 });

    await expect(cancelScheduledMessage({ id: 's1' })).rejects.toMatchObject({ status: 400 });
  });

  it('refuses a message that is already sending', async () => {
    prisma.messageSchedule.findUnique.mockResolvedValue({ id: 's1', status: 'SENDING' });

    await expect(cancelScheduledMessage({ id: 's1' })).rejects.toMatchObject({ status: 400 });
    expect(prisma.messageSchedule.updateMany).not.toHaveBeenCalled();
  });
});
