// Decision emails leave only when an admin approves them, and each person gets
// exactly one. These check the guards that make that true.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendEmail } from './emailNotifications.js';
import {
  INVITE_TTL_MS,
  requeueFailedDecisionEmails,
  sendDecisionEmails,
  setMessagesExcluded
} from './decisionBatches.js';

vi.mock('../prismaClient.js', () => ({ default: {} }));
vi.mock('./emailNotifications.js', () => ({ sendEmail: vi.fn() }));

const BATCH = {
  id: 'batch-1',
  cycleId: 'cycle-1',
  round: '4',
  templates: {
    ACCEPTED: { subject: 'Welcome, {{firstName}}', body: 'Hi {{firstName}}.\n\n{{accountSetup}}' },
    REJECTED: { subject: 'Update', body: 'Thank you, {{firstName}}.' }
  }
};

const message = (overrides = {}) => ({
  id: 'm1',
  batchId: 'batch-1',
  outcome: 'ACCEPTED',
  status: 'PENDING',
  email: 'sam@ucla.edu',
  firstName: 'Sam',
  lastName: 'Lee',
  needsInvite: false,
  userId: 'user-sam',
  error: null,
  ...overrides
});

// An in-memory decision_messages table honouring the filters the service uses.
function fakeClient(messages) {
  const rows = new Map(messages.map((row) => [row.id, { ...row }]));
  const matches = (row, where) => {
    const ids = where.id?.in ?? (typeof where.id === 'string' ? [where.id] : null);
    if (ids && !ids.includes(row.id)) return false;
    if (where.status && row.status !== where.status) return false;
    if (where.outcome && row.outcome !== where.outcome) return false;
    if (where.updatedAt) return false; // nothing here is stuck mid-send
    return true;
  };

  const client = {
    decisionBatch: { findUnique: vi.fn().mockResolvedValue(BATCH) },
    recruitingCycle: { findUnique: vi.fn().mockResolvedValue({ name: 'Fall 2026' }) },
    decisionMessage: {
      findMany: vi.fn(({ where }) =>
        Promise.resolve([...rows.values()].filter((row) => matches(row, where)).map((row) => ({ id: row.id })))
      ),
      updateMany: vi.fn(({ where, data }) => {
        let count = 0;
        for (const row of rows.values()) {
          if (!matches(row, where)) continue;
          if (data.status) row.status = data.status;
          if ('error' in data) row.error = data.error;
          count += 1;
        }
        return Promise.resolve({ count });
      }),
      findUnique: vi.fn(({ where }) => Promise.resolve({ ...rows.get(where.id) })),
      update: vi.fn(({ where, data }) => Promise.resolve(Object.assign(rows.get(where.id), data)))
    },
    user: { update: vi.fn().mockResolvedValue({}) },
    messageLog: { create: vi.fn().mockResolvedValue({}) }
  };
  return { client, rows };
}

beforeEach(() => {
  vi.clearAllMocks();
  sendEmail.mockResolvedValue({ success: true, messageId: 'provider-1' });
});

describe('sending decision emails', () => {
  it('sends nothing when the list has changed since the admin reviewed it', async () => {
    const { client, rows } = fakeClient([message({ id: 'm1' }), message({ id: 'm2', email: 'ava@ucla.edu' })]);

    await expect(
      sendDecisionEmails({ batchId: 'batch-1', outcome: 'ACCEPTED', expectedCount: 3, sentBy: 'exec-1' }, client)
    ).rejects.toMatchObject({ status: 409 });

    expect(sendEmail).not.toHaveBeenCalled();
    expect([...rows.values()].every((row) => row.status === 'PENDING')).toBe(true);
  });

  it('sends only the outcome that was approved', async () => {
    const { client } = fakeClient([message({ id: 'm1' }), message({ id: 'm2', outcome: 'REJECTED', email: 'max@ucla.edu' })]);

    const result = await sendDecisionEmails({ batchId: 'batch-1', outcome: 'REJECTED', expectedCount: 1, sentBy: 'exec-1' }, client);

    expect(result).toMatchObject({ sent: 1, total: 1 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toBe('max@ucla.edu');
  });

  it('skips a message another sender claimed first, so nobody is emailed twice', async () => {
    const { client, rows } = fakeClient([message({ id: 'm1' }), message({ id: 'm2', email: 'ava@ucla.edu' })]);
    // Both looked ready when listed; m2 was claimed by a second admin a moment later.
    client.decisionMessage.findMany.mockResolvedValueOnce([{ id: 'm1' }, { id: 'm2' }]);
    rows.get('m2').status = 'SENDING';

    const result = await sendDecisionEmails({ batchId: 'batch-1', outcome: 'ACCEPTED', expectedCount: 2, sentBy: 'exec-1' }, client);

    expect(result).toMatchObject({ sent: 1, skipped: 1 });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toBe('sam@ucla.edu');
  });

  it('never sends the same message again once it is sent', async () => {
    const { client } = fakeClient([message({ id: 'm1' })]);
    await sendDecisionEmails({ batchId: 'batch-1', outcome: 'ACCEPTED', expectedCount: 1, sentBy: 'exec-1' }, client);
    const again = await sendDecisionEmails({ batchId: 'batch-1', outcome: 'ACCEPTED', sentBy: 'exec-1' }, client);

    expect(again.total).toBe(0);
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('gives a new member a set-password link minted at send time', async () => {
    const { client, rows } = fakeClient([message({ id: 'm1', needsInvite: true, userId: 'user-new' })]);
    const before = Date.now();

    await sendDecisionEmails({ batchId: 'batch-1', outcome: 'ACCEPTED', expectedCount: 1, sentBy: 'exec-1' }, client);

    const { where, data } = client.user.update.mock.calls[0][0];
    expect(where).toEqual({ id: 'user-new' });
    expect(data.resetToken).toMatch(/^[0-9a-f]{64}$/);
    expect(data.resetTokenExpiry.getTime()).toBeGreaterThanOrEqual(before + INVITE_TTL_MS);
    expect(sendEmail.mock.calls[0][2]).toContain(`/reset-password?token=${data.resetToken}`);
    expect(rows.get('m1')).toMatchObject({ status: 'SENT', sentById: 'exec-1', providerMessageId: 'provider-1' });
  });

  it('records a failure without losing the successes, and logs what was sent', async () => {
    const { client, rows } = fakeClient([message({ id: 'm1' }), message({ id: 'm2', email: 'bounce@ucla.edu' })]);
    sendEmail.mockImplementation((to) =>
      Promise.resolve(to === 'bounce@ucla.edu' ? { success: false, error: 'Mailbox unavailable' } : { success: true })
    );

    const result = await sendDecisionEmails({ batchId: 'batch-1', outcome: 'ACCEPTED', expectedCount: 2, sentBy: 'exec-1' }, client);

    expect(result).toMatchObject({ sent: 1, failed: 1 });
    expect(rows.get('m1').status).toBe('SENT');
    expect(rows.get('m2')).toMatchObject({ status: 'FAILED', error: 'Mailbox unavailable' });
    expect(client.messageLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ recipientCount: 1, channel: 'email', cycleId: 'cycle-1', sentBy: 'exec-1' })
    });
  });
});

describe('reviewing recipients', () => {
  it('only takes unsent messages out of a send', async () => {
    const { client } = fakeClient([message({ id: 'm1' }), message({ id: 'm2', status: 'SENT' })]);
    const result = await setMessagesExcluded({ batchId: 'batch-1', messageIds: ['m1', 'm2'], excluded: true }, client);
    expect(result.updated).toBe(1);
    expect(client.decisionMessage.updateMany.mock.calls[0][0].where.status).toBe('PENDING');
  });

  it('puts failed messages back in the queue without sending them', async () => {
    const { client, rows } = fakeClient([message({ id: 'm1', status: 'FAILED', error: 'Mailbox unavailable' })]);
    const result = await requeueFailedDecisionEmails({ batchId: 'batch-1', outcome: 'ACCEPTED' }, client);
    expect(result.requeued).toBe(1);
    expect(rows.get('m1')).toMatchObject({ status: 'PENDING', error: null });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
