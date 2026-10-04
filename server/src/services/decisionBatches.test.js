// Decision emails leave only when an admin approves them, and each person gets
// exactly one. These check the guards on approving; decisionSendQueue.test.js
// covers the sending.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendEmail } from './emailNotifications.js';
import {
  cancelQueuedDecisionEmails,
  getDecisionBatch,
  isDeliverableAddress,
  queueDecisionEmails,
  requeueFailedDecisionEmails,
  resolveUnconfirmedDecisionEmails,
  setMessagesExcluded,
  updateDecisionMessageEmail
} from './decisionBatches.js';

vi.mock('../prismaClient.js', () => ({ default: {} }));
vi.mock('./emailNotifications.js', () => ({ sendEmail: vi.fn() }));

const BATCH = {
  id: 'batch-1',
  cycleId: 'cycle-1',
  round: '4',
  processedById: 'exec-1',
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
  attempts: 0,
  error: null,
  ...overrides
});

// An in-memory decision_messages table honouring the filters the service uses.
function fakeClient(messages, logRows = []) {
  const rows = new Map(messages.map((row) => [row.id, { ...row }]));
  const matches = (row, where) => {
    const ids = where.id?.in ?? (typeof where.id === 'string' ? [where.id] : null);
    if (ids && !ids.includes(row.id)) return false;
    if (typeof where.status === 'string' && row.status !== where.status) return false;
    if (where.status?.in && !where.status.in.includes(row.status)) return false;
    if (where.outcome && row.outcome !== where.outcome) return false;
    return true;
  };

  const client = {
    decisionBatch: { findUnique: vi.fn().mockResolvedValue(BATCH) },
    recruitingCycle: { findUnique: vi.fn().mockResolvedValue({ id: 'cycle-1', name: 'Fall 2026' }) },
    user: { findUnique: vi.fn().mockResolvedValue({ id: 'exec-1', fullName: 'Exec' }) },
    decisionMessage: {
      findMany: vi.fn(({ where }) =>
        Promise.resolve([...rows.values()].filter((row) => matches(row, where)).map((row) => ({ ...row })))
      ),
      updateMany: vi.fn(({ where, data }) => {
        let count = 0;
        for (const row of rows.values()) {
          if (!matches(row, where)) continue;
          Object.assign(row, data);
          count += 1;
        }
        return Promise.resolve({ count });
      })
    },
    communicationLog: {
      findMany: vi.fn(({ where }) => Promise.resolve(logRows.filter((row) => where.attemptKey.in.includes(row.attemptKey))))
    },
    messageLog: { create: vi.fn().mockResolvedValue({}) }
  };
  return { client, rows };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('approving a send', () => {
  it('queues nothing when the list has changed since the admin reviewed it', async () => {
    const { client, rows } = fakeClient([message({ id: 'm1' }), message({ id: 'm2', email: 'ava@ucla.edu' })]);

    await expect(
      queueDecisionEmails({ batchId: 'batch-1', outcome: 'ACCEPTED', expectedCount: 3, sentBy: 'exec-1' }, client)
    ).rejects.toMatchObject({ status: 409 });

    expect([...rows.values()].every((row) => row.status === 'PENDING')).toBe(true);
  });

  it('queues only the outcome that was approved, and sends nothing itself', async () => {
    const { client, rows } = fakeClient([message({ id: 'm1' }), message({ id: 'm2', outcome: 'REJECTED', email: 'max@ucla.edu' })]);

    const result = await queueDecisionEmails({ batchId: 'batch-1', outcome: 'REJECTED', expectedCount: 1, sentBy: 'exec-1' }, client);

    expect(result).toEqual({ queued: 1 });
    expect(rows.get('m2')).toMatchObject({ status: 'QUEUED', sentById: 'exec-1' });
    expect(rows.get('m2').nextAttemptAt).toBeInstanceOf(Date);
    expect(rows.get('m1').status).toBe('PENDING');
    expect(sendEmail).not.toHaveBeenCalled();
    expect(client.messageLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ recipientCount: 1, channel: 'email', cycleId: 'cycle-1', sentBy: 'exec-1' })
    });
  });

  it('refuses a list holding an address that cannot receive mail', async () => {
    // 2026-10-03: a rejection was queued to "d" and failed at SES.
    const { client, rows } = fakeClient([message({ id: 'm1' }), message({ id: 'm2', email: 'd', firstName: 'Dana' })]);

    await expect(
      queueDecisionEmails({ batchId: 'batch-1', outcome: 'ACCEPTED', expectedCount: 2, sentBy: 'exec-1' }, client)
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Dana Lee ("d")') });

    expect([...rows.values()].every((row) => row.status === 'PENDING')).toBe(true);
  });

  it('queues nothing twice: a second approval finds nothing ready', async () => {
    const { client } = fakeClient([message({ id: 'm1' })]);
    await queueDecisionEmails({ batchId: 'batch-1', outcome: 'ACCEPTED', expectedCount: 1, sentBy: 'exec-1' }, client);
    const again = await queueDecisionEmails({ batchId: 'batch-1', outcome: 'ACCEPTED', sentBy: 'exec-1' }, client);
    expect(again).toEqual({ queued: 0 });
  });

  it('can stop what is still queued without touching what was sent', async () => {
    const { client, rows } = fakeClient([message({ id: 'm1', status: 'QUEUED' }), message({ id: 'm2', status: 'SENT' })]);
    const result = await cancelQueuedDecisionEmails({ batchId: 'batch-1', outcome: 'ACCEPTED' }, client);
    expect(result.stopped).toBe(1);
    expect([rows.get('m1').status, rows.get('m2').status]).toEqual(['PENDING', 'SENT']);
  });
});

describe('reviewing recipients', () => {
  it('only takes unsent messages out of a send', async () => {
    const { client } = fakeClient([message({ id: 'm1' }), message({ id: 'm2', status: 'SENT' })]);
    const result = await setMessagesExcluded({ batchId: 'batch-1', messageIds: ['m1', 'm2'], excluded: true }, client);
    expect(result.updated).toBe(1);
    expect(client.decisionMessage.updateMany.mock.calls[0][0].where.status).toBe('PENDING');
  });

  it('puts failed messages back to Ready without sending them, and leaves unconfirmed ones alone', async () => {
    const { client, rows } = fakeClient([
      message({ id: 'm1', status: 'FAILED', error: 'Mailbox unavailable' }),
      message({ id: 'm2', status: 'UNCONFIRMED' })
    ]);
    const result = await requeueFailedDecisionEmails({ batchId: 'batch-1', outcome: 'ACCEPTED' }, client);
    expect(result.requeued).toBe(1);
    expect(rows.get('m1')).toMatchObject({ status: 'PENDING', error: null });
    expect(rows.get('m2').status).toBe('UNCONFIRMED');
  });

  it('settles an unconfirmed send either way, and nothing else', async () => {
    const { client, rows } = fakeClient([
      message({ id: 'm1', status: 'UNCONFIRMED' }),
      message({ id: 'm2', status: 'UNCONFIRMED' }),
      message({ id: 'm3', status: 'FAILED' })
    ]);

    await resolveUnconfirmedDecisionEmails({ batchId: 'batch-1', messageIds: ['m1', 'm3'], resolution: 'MARK_SENT', resolvedBy: 'exec-2' }, client);
    await resolveUnconfirmedDecisionEmails({ batchId: 'batch-1', messageIds: ['m2'], resolution: 'SEND_AGAIN', resolvedBy: 'exec-2' }, client);

    expect(rows.get('m1')).toMatchObject({ status: 'SENT', sentById: 'exec-2' });
    expect(rows.get('m2').status).toBe('PENDING');
    expect(rows.get('m3').status).toBe('FAILED');
  });

  it('fixes an address on an unsent message only', async () => {
    const { client, rows } = fakeClient([message({ id: 'm1', email: 'd' }), message({ id: 'm2', status: 'SENT' })]);

    await expect(updateDecisionMessageEmail({ batchId: 'batch-1', messageId: 'm1', email: 'nope' }, client)).rejects.toMatchObject({ status: 400 });
    await updateDecisionMessageEmail({ batchId: 'batch-1', messageId: 'm1', email: ' dana@ucla.edu ' }, client);
    await expect(updateDecisionMessageEmail({ batchId: 'batch-1', messageId: 'm2', email: 'x@ucla.edu' }, client)).rejects.toMatchObject({ status: 409 });

    expect(rows.get('m1').email).toBe('dana@ucla.edu');
    expect(rows.get('m2').email).toBe('sam@ucla.edu');
  });

  it('shows what SES reported for each message, and which addresses cannot receive mail', async () => {
    const { client } = fakeClient(
      [message({ id: 'm1', status: 'SENT', attempts: 1 }), message({ id: 'm2', email: 'd' })],
      [{ attemptKey: 'decision-message:m1:1|sam@ucla.edu', status: 'DELIVERED', error: null }]
    );

    const batch = await getDecisionBatch('batch-1', client);
    const [m1, m2] = batch.groups.find((group) => group.outcome === 'ACCEPTED').messages;

    expect(m1).toMatchObject({ delivery: { status: 'DELIVERED' }, addressOk: true });
    expect(m2).toMatchObject({ delivery: null, addressOk: false });
  });
});

describe('isDeliverableAddress', () => {
  it.each([
    ['sam@ucla.edu', true],
    ['  sam@g.ucla.edu ', true],
    ['d', false],
    ['sam@ucla', false],
    ['', false],
    [null, false]
  ])('%s -> %s', (email, ok) => {
    expect(isDeliverableAddress(email)).toBe(ok);
  });
});
