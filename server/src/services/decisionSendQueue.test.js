// The send worker for approved decision emails. What matters: everyone
// approved gets exactly one email, and a send cut off by a restart is finished
// or flagged by the next run without anyone reading the database.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendEmail } from './emailNotifications.js';
import {
  MAX_ATTEMPTS,
  STUCK_SENDING_MS,
  UNCONFIRMED_NOTE,
  processDecisionQueue,
  recoverInterruptedSends
} from './decisionSendQueue.js';

vi.mock('../prismaClient.js', () => ({ default: {} }));
vi.mock('./emailNotifications.js', () => ({ sendEmail: vi.fn() }));

const BATCH = {
  id: 'batch-1',
  cycleId: 'cycle-1',
  round: '1',
  templates: {
    ADVANCED: { subject: 'Advancing, {{firstName}}', body: 'Hi {{firstName}}. {{schedulingLink}}' },
    ACCEPTED: { subject: 'Welcome', body: '{{accountSetup}}' }
  }
};

const NOW = new Date('2026-10-04T03:00:00Z');
const LONG_AGO = new Date(NOW.getTime() - STUCK_SENDING_MS - 1000);

const message = (overrides = {}) => ({
  id: 'm1',
  batchId: 'batch-1',
  outcome: 'ADVANCED',
  status: 'QUEUED',
  email: 'sam@ucla.edu',
  firstName: 'Sam',
  lastName: 'Lee',
  needsInvite: false,
  userId: null,
  toRound: '2',
  attempts: 0,
  sentById: 'exec-1',
  nextAttemptAt: new Date(NOW.getTime() - 1000),
  updatedAt: NOW,
  error: null,
  ...overrides
});

// In-memory decision_messages and communication_logs, honouring the filters the worker uses.
function fakeClient(messages, logRows = []) {
  const rows = new Map(messages.map((row) => [row.id, { ...row }]));
  const logs = new Map(logRows.map((row) => [row.attemptKey, { ...row }]));

  const matches = (row, where) => {
    const ids = where.id?.in ?? (typeof where.id === 'string' ? [where.id] : null);
    if (ids && !ids.includes(row.id)) return false;
    if (where.status && row.status !== where.status) return false;
    if (where.attempts !== undefined && row.attempts !== where.attempts) return false;
    if (where.updatedAt?.lt && !(row.updatedAt < where.updatedAt.lt)) return false;
    if (where.nextAttemptAt?.lte && !(row.nextAttemptAt && row.nextAttemptAt <= where.nextAttemptAt.lte)) return false;
    return true;
  };
  const apply = (row, data) => {
    for (const [key, value] of Object.entries(data)) {
      row[key] = value && typeof value === 'object' && 'increment' in value ? row[key] + value.increment : value;
    }
  };

  const client = {
    decisionBatch: { findUnique: vi.fn().mockResolvedValue(BATCH) },
    recruitingCycle: { findUnique: vi.fn().mockResolvedValue({ name: 'Fall 2026' }) },
    interview: { findMany: vi.fn().mockResolvedValue([]) },
    user: { update: vi.fn().mockResolvedValue({}) },
    decisionMessage: {
      findMany: vi.fn(({ where, take }) =>
        Promise.resolve([...rows.values()].filter((row) => matches(row, where)).slice(0, take ?? Infinity).map((row) => ({ ...row })))
      ),
      updateMany: vi.fn(({ where, data }) => {
        let count = 0;
        for (const row of rows.values()) {
          if (!matches(row, where)) continue;
          apply(row, data);
          count += 1;
        }
        return Promise.resolve({ count });
      }),
      findUnique: vi.fn(({ where }) => Promise.resolve({ ...rows.get(where.id) })),
      update: vi.fn(({ where, data }) => {
        apply(rows.get(where.id), data);
        return Promise.resolve({ ...rows.get(where.id) });
      })
    },
    communicationLog: {
      findMany: vi.fn(({ where }) => Promise.resolve(where.attemptKey.in.map((key) => logs.get(key)).filter(Boolean))),
      create: vi.fn(({ data }) => {
        logs.set(data.attemptKey, { ...data });
        return Promise.resolve(data);
      })
    }
  };
  return { client, rows, logs };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  sendEmail.mockResolvedValue({ success: true, messageId: 'ses-1' });
});

describe('sending what was approved', () => {
  it('sends every queued message once and marks it sent', async () => {
    const { client, rows } = fakeClient([message({ id: 'm1' }), message({ id: 'm2', email: 'ava@ucla.edu' })]);

    const totals = await processDecisionQueue(client);

    expect(totals).toMatchObject({ sent: 2, failed: 0 });
    expect(sendEmail.mock.calls.map((call) => call[0]).sort()).toEqual(['ava@ucla.edu', 'sam@ucla.edu']);
    expect(rows.get('m1')).toMatchObject({ status: 'SENT', attempts: 1, providerMessageId: 'ses-1' });
  });

  it('touches nothing that was not approved', async () => {
    const { client } = fakeClient([message({ id: 'm1', status: 'PENDING' }), message({ id: 'm2', status: 'EXCLUDED' })]);
    await processDecisionQueue(client);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('writes the log row before calling SES, under the key the send overwrites', async () => {
    const { client } = fakeClient([message({ id: 'm1' })]);
    sendEmail.mockImplementation(async () => {
      // By the time SES is asked, the claim is already on record.
      expect(client.communicationLog.create).toHaveBeenCalledTimes(1);
      return { success: true, messageId: 'ses-1' };
    });

    await processDecisionQueue(client);

    const claim = client.communicationLog.create.mock.calls[0][0].data;
    expect(claim).toMatchObject({ status: 'SENDING', attemptKey: 'decision-message:m1:1|sam@ucla.edu', triggeredById: 'exec-1' });
    expect(sendEmail.mock.calls[0][4].attemptKey).toBe('decision-message:m1:1');
  });

  it('does not call SES when the claim cannot be recorded, and tries again later', async () => {
    const { client, rows } = fakeClient([message({ id: 'm1' })]);
    client.communicationLog.create.mockRejectedValueOnce(new Error('pool timeout'));

    await processDecisionQueue(client);

    expect(sendEmail).not.toHaveBeenCalled();
    expect(rows.get('m1').status).toBe('QUEUED');
    expect(rows.get('m1').nextAttemptAt.getTime()).toBeGreaterThan(NOW.getTime());
  });

  it('retries a failed send on a later run, then leaves it failed for an admin', async () => {
    const { client, rows } = fakeClient([message({ id: 'm1' })]);
    sendEmail.mockResolvedValue({ success: false, error: 'Throttling' });

    for (let run = 1; run <= MAX_ATTEMPTS; run++) {
      await processDecisionQueue(client);
      rows.get('m1').nextAttemptAt = new Date(NOW.getTime() - 1); // the backoff has passed
    }

    expect(rows.get('m1')).toMatchObject({ status: 'FAILED', attempts: MAX_ATTEMPTS, error: 'Throttling' });
    await processDecisionQueue(client);
    expect(rows.get('m1').attempts).toBe(MAX_ATTEMPTS);
  });

  it('waits out the backoff instead of retrying straight away', async () => {
    const { client } = fakeClient([message({ id: 'm1' })]);
    sendEmail.mockResolvedValue({ success: false, error: 'Throttling' });

    await processDecisionQueue(client);
    await processDecisionQueue(client);

    // Three quick transport tries in the first run, none in the second.
    expect(sendEmail).toHaveBeenCalledTimes(3);
  });

  it('skips a message another server claimed first', async () => {
    const { client, rows } = fakeClient([message({ id: 'm1' })]);
    client.decisionMessage.findMany.mockImplementationOnce(() => Promise.resolve([])); // recovery: nothing stuck
    client.decisionMessage.findMany.mockImplementationOnce(() => {
      rows.get('m1').status = 'SENDING'; // claimed elsewhere between the read and the claim
      return Promise.resolve([{ id: 'm1' }]);
    });

    const totals = await processDecisionQueue(client);

    expect(totals.skipped).toBe(1);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('gives a new member a set-password link minted at send time', async () => {
    const { client } = fakeClient([message({ id: 'm1', outcome: 'ACCEPTED', needsInvite: true, userId: 'user-new' })]);

    await processDecisionQueue(client);

    const { data } = client.user.update.mock.calls[0][0];
    expect(sendEmail.mock.calls[0][2]).toContain(`/reset-password?token=${data.resetToken}`);
  });
});

describe('finishing a send a restart cut off', () => {
  const stuck = (overrides) =>
    message({ status: 'SENDING', attempts: 1, updatedAt: LONG_AGO, ...overrides });

  it('marks it sent when SES accepted it', async () => {
    const { client, rows } = fakeClient(
      [stuck({ id: 'm1' })],
      [{ attemptKey: 'decision-message:m1:1|sam@ucla.edu', status: 'SENT', sentAt: LONG_AGO, providerMessageId: 'ses-9' }]
    );

    await recoverInterruptedSends(client, NOW);

    expect(rows.get('m1')).toMatchObject({ status: 'SENT', providerMessageId: 'ses-9', sentAt: LONG_AGO });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('counts a delivery report or a bounce as sent too', async () => {
    const { client, rows } = fakeClient(
      [stuck({ id: 'm1' }), stuck({ id: 'm2', email: 'gone@ucla.edu' })],
      [
        { attemptKey: 'decision-message:m1:1|sam@ucla.edu', status: 'DELIVERED' },
        { attemptKey: 'decision-message:m2:1|gone@ucla.edu', status: 'BOUNCED' }
      ]
    );
    await recoverInterruptedSends(client, NOW);
    expect([rows.get('m1').status, rows.get('m2').status]).toEqual(['SENT', 'SENT']);
  });

  it('sends it again when the claim never reached the log, because SES was never asked', async () => {
    const { client, rows } = fakeClient([stuck({ id: 'm1' })]);

    await processDecisionQueue(client);

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(rows.get('m1')).toMatchObject({ status: 'SENT', attempts: 2 });
  });

  it('retries it when the log says SES refused it', async () => {
    const { client, rows } = fakeClient(
      [stuck({ id: 'm1' })],
      [{ attemptKey: 'decision-message:m1:1|sam@ucla.edu', status: 'FAILED', error: 'Throttling' }]
    );
    await recoverInterruptedSends(client, NOW);
    expect(rows.get('m1')).toMatchObject({ status: 'QUEUED', error: 'Throttling' });
  });

  it('asks an admin when it was cut off while SES was being asked', async () => {
    const { client, rows } = fakeClient(
      [stuck({ id: 'm1' })],
      [{ attemptKey: 'decision-message:m1:1|sam@ucla.edu', status: 'SENDING' }]
    );

    await processDecisionQueue(client);

    expect(rows.get('m1')).toMatchObject({ status: 'UNCONFIRMED', error: UNCONFIRMED_NOTE });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('asks an admin about a send from before the worker, which logged only afterwards', async () => {
    // 2026-10-03: five messages were left SENDING. Three had log rows saying SES
    // took them; two had none, which for the old code proved nothing.
    const { client, rows } = fakeClient(
      [stuck({ id: 'old-sent', nextAttemptAt: null }), stuck({ id: 'old-unknown', email: 'ci@ucla.edu', nextAttemptAt: null })],
      [{ attemptKey: 'decision-message:old-sent:1|sam@ucla.edu', status: 'SENT', sentAt: LONG_AGO }]
    );

    await processDecisionQueue(client);

    expect(rows.get('old-sent').status).toBe('SENT');
    expect(rows.get('old-unknown').status).toBe('UNCONFIRMED');
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('leaves a send that is still in progress alone', async () => {
    const { client, rows } = fakeClient([message({ id: 'm1', status: 'SENDING', attempts: 1, updatedAt: NOW })]);
    await recoverInterruptedSends(client, NOW);
    expect(rows.get('m1').status).toBe('SENDING');
  });
});
