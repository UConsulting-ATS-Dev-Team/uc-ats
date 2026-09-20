// What a hand-written send leaves behind.
//
// Two records, not one. message_logs keeps the campaign - one row saying an
// admin sent this text to this audience. communication_logs keeps the people -
// one row each, so "did Ryan get it" is answerable.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import { sendEmail } from './emailNotifications.js';
import { sendSlackMessage } from './slackService.js';
import { recordCommunications } from './communicationLog.js';
import { sendMasterCommunication, logImessageSend } from './masterCommunications.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findMany: vi.fn() },
    application: { findMany: vi.fn() },
    messageLog: { create: vi.fn() },
  },
}));

vi.mock('./emailNotifications.js', () => ({ sendEmail: vi.fn() }));
vi.mock('./slackService.js', () => ({ sendSlackMessage: vi.fn() }));
vi.mock('./communicationLog.js', () => ({ recordCommunications: vi.fn() }));

const members = [
  { id: 'u1', email: 'a@uc.org', fullName: 'Ada Lovelace', firstName: 'Ada', lastName: 'Lovelace', phoneNumber: '+13105550001', role: 'MEMBER' },
  { id: 'u2', email: 'b@uc.org', fullName: 'Grace Hopper', firstName: 'Grace', lastName: 'Hopper', phoneNumber: null, role: 'MEMBER' },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  prisma.user.findMany.mockResolvedValue(members);
  prisma.application.findMany.mockResolvedValue([]);
  prisma.messageLog.create.mockResolvedValue({ id: 'campaign-1' });
  sendEmail.mockResolvedValue({ success: true, messageId: 'ses-1' });
  recordCommunications.mockResolvedValue(2);
});

const metaOf = (i = 0) => sendEmail.mock.calls[i][4];

describe('a bulk email send', () => {
  it('labels every message as a person\'s doing, not the system\'s', async () => {
    await sendMasterCommunication({
      audience: 'members',
      channel: 'email',
      filters: {},
      subject: 'Retreat',
      body: 'Hi {{firstName}}',
      sentBy: 'admin-1',
      cycleId: 'cycle-1',
    });

    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(metaOf()).toMatchObject({
      category: 'MASTER_COMMUNICATION',
      trigger: 'MANUAL',
      triggeredById: 'admin-1',
      cycleId: 'cycle-1',
    });
  });

  it('carries each recipient\'s name so the log reads as people, not addresses', async () => {
    await sendMasterCommunication({
      audience: 'members',
      channel: 'email',
      filters: {},
      subject: 'Retreat',
      body: 'Hi',
      sentBy: 'admin-1',
      cycleId: 'cycle-1',
    });

    expect(metaOf(0).recipientName).toBe('Ada Lovelace');
    expect(metaOf(1).recipientName).toBe('Grace Hopper');
  });

  // The campaign row is written first precisely so that every per-recipient row
  // can name it. Written afterwards, as it used to be, there would be nothing
  // to point at while the mail was going out.
  it('writes the campaign record before the first email, and ties the two together', async () => {
    await sendMasterCommunication({
      audience: 'members',
      channel: 'email',
      filters: {},
      subject: 'Retreat',
      body: 'Hi',
      sentBy: 'admin-1',
      cycleId: 'cycle-1',
    });

    expect(prisma.messageLog.create.mock.invocationCallOrder[0]).toBeLessThan(
      sendEmail.mock.invocationCallOrder[0]
    );
    expect(metaOf().messageLogId).toBe('campaign-1');
  });

  it('still counts the whole audience on the campaign row', async () => {
    await sendMasterCommunication({
      audience: 'members',
      channel: 'email',
      filters: {},
      subject: 'Retreat',
      body: 'Hi',
      sentBy: 'admin-1',
      cycleId: 'cycle-1',
    });

    expect(prisma.messageLog.create.mock.calls[0][0].data.recipientCount).toBe(2);
  });
});

describe('a Slack broadcast', () => {
  it('is labelled and tied to its campaign row', async () => {
    prisma.user.findMany.mockResolvedValue(
      members.map((m) => ({ ...m, audience: 'user' }))
    );

    await sendMasterCommunication({
      audience: 'users',
      channel: 'slack',
      filters: { roles: ['USER'] },
      subject: 'Heads up',
      body: 'Applications close Friday',
      sentBy: 'admin-1',
      cycleId: 'cycle-1',
    });

    expect(sendSlackMessage.mock.calls[0][1]).toMatchObject({
      category: 'MASTER_COMMUNICATION',
      trigger: 'MANUAL',
      triggeredById: 'admin-1',
      messageLogId: 'campaign-1',
    });
  });
});

describe('an iMessage hand-off', () => {
  it('records one row per person, as opened rather than sent', async () => {
    await logImessageSend({
      recipientIds: ['u1', 'u2'],
      body: 'Retreat is Saturday',
      cycleId: 'cycle-1',
      sentBy: 'admin-1',
    });

    const rows = recordCommunications.mock.calls[0][0];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      channel: 'imessage',
      status: 'OPENED',
      recipient: '+13105550001',
      recipientName: 'Ada Lovelace',
      trigger: 'MANUAL',
      messageLogId: 'campaign-1',
    });
  });

  // Not everyone has a number on file, and an email address still identifies
  // who the conversation was opened with.
  it('falls back to the email address when there is no number', async () => {
    await logImessageSend({
      recipientIds: ['u1', 'u2'],
      body: 'Retreat is Saturday',
      sentBy: 'admin-1',
    });

    expect(recordCommunications.mock.calls[0][0][1].recipient).toBe('b@uc.org');
  });
});
