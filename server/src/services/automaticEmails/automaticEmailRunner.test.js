import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../prismaClient.js', () => ({ default: {} }));
vi.mock('./automaticEmailFinders.js', () => ({ findOccurrences: vi.fn() }));
vi.mock('../emailNotifications.js', () => ({ sendEmail: vi.fn() }));
vi.mock('./automaticEmails.js', () => ({
  renderAutomaticEmail: vi.fn(async (rule, values, { unsubscribeUrl }) => ({
    subject: `Hi ${values.firstName}`,
    html: `<p>body</p>${unsubscribeUrl ? `<a href="${unsubscribeUrl}">Unsubscribe</a>` : ''}`,
  })),
}));
vi.mock('../emailSuppression.js', () => ({
  applySuppressions: vi.fn(),
  unsubscribeUrls: (email) => ({ page: `https://x.test/unsub?e=${email}`, oneClick: `https://x.test/one-click?e=${email}` }),
}));

import { findOccurrences } from './automaticEmailFinders.js';
import { sendEmail } from '../emailNotifications.js';
import { applySuppressions } from '../emailSuppression.js';
import { runAutomaticEmails } from './automaticEmailRunner.js';

const RULE = { id: 'rule-1', name: 'Welcome', enabled: true, enabledAt: new Date(), marketing: false };
const occ = (n) => ({ subjectKey: `k${n}`, email: `p${n}@ucla.edu`, values: { firstName: `P${n}`, fullName: `P${n} Q` } });

let rows;
const client = {
  automaticEmail: { findMany: vi.fn() },
  automaticEmailSend: {
    findMany: vi.fn(async ({ where }) => rows.filter((r) => where.subjectKey.in.includes(r.subjectKey))),
    create: vi.fn(async ({ data }) => {
      if (rows.some((r) => r.subjectKey === data.subjectKey)) throw Object.assign(new Error('dup'), { code: 'P2002' });
      const row = { id: `send-${data.subjectKey}`, ...data };
      rows.push(row);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }) => {
      const row = rows.find((r) => r.id === where.id && r.status === where.status && r.attempts < where.attempts.lt);
      if (!row) return { count: 0 };
      Object.assign(row, { status: data.status, attempts: row.attempts + 1 });
      return { count: 1 };
    }),
    update: vi.fn(async ({ where, data }) => Object.assign(rows.find((r) => r.id === where.id), data)),
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  rows = [];
  client.automaticEmail.findMany.mockResolvedValue([RULE]);
  sendEmail.mockResolvedValue({ success: true });
});

describe('runAutomaticEmails', () => {
  it('sends once per occurrence, however many times it runs', async () => {
    findOccurrences.mockResolvedValue([occ(1), occ(2)]);

    expect(await runAutomaticEmails({ client })).toMatchObject({ sent: 2 });
    expect(await runAutomaticEmails({ client })).toMatchObject({ sent: 0 });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(rows.map((r) => r.status)).toEqual(['SENT', 'SENT']);
  });

  it('claims before sending, so a run racing it cannot send the same one', async () => {
    findOccurrences.mockResolvedValue([occ(1)]);
    // Another run claimed k1 between this run's read and its claim.
    client.automaticEmailSend.findMany.mockImplementationOnce(async () => {
      rows.push({ id: 'other', subjectKey: 'k1', status: 'SENDING', attempts: 1 });
      return [];
    });

    await runAutomaticEmails({ client });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('logs every send as a custom automatic email with a stable attempt key', async () => {
    findOccurrences.mockResolvedValue([occ(1)]);
    await runAutomaticEmails({ client });

    expect(sendEmail).toHaveBeenCalledWith('p1@ucla.edu', 'Hi P1', expect.any(String), [], expect.objectContaining({
      category: 'CUSTOM_AUTOMATIC',
      attemptKey: 'automatic-email:send-k1',
      listUnsubscribeUrl: null,
    }));
  });

  it('retries a failed send, three attempts in all, then stops', async () => {
    findOccurrences.mockResolvedValue([occ(1)]);
    sendEmail.mockResolvedValue({ success: false, error: 'SES throttled' });

    for (let i = 0; i < 5; i++) await runAutomaticEmails({ client });

    expect(sendEmail).toHaveBeenCalledTimes(3);
    expect(rows[0]).toMatchObject({ status: 'FAILED', attempts: 3, reason: 'SES throttled' });
  });

  it('never retries one left mid-send, since it may already have gone', async () => {
    findOccurrences.mockResolvedValue([occ(1)]);
    rows.push({ id: 'stuck', subjectKey: 'k1', status: 'SENDING', attempts: 1 });

    await runAutomaticEmails({ client });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('leaves skipped people alone', async () => {
    findOccurrences.mockResolvedValue([occ(1)]);
    rows.push({ id: 'seed', subjectKey: 'k1', status: 'SKIPPED', attempts: 0 });

    await runAutomaticEmails({ client });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('drains a large batch over several runs', async () => {
    findOccurrences.mockResolvedValue(Array.from({ length: 250 }, (_, i) => occ(i)));

    expect((await runAutomaticEmails({ client })).sent).toBe(200);
    expect((await runAutomaticEmails({ client })).sent).toBe(50);
  });

  describe('marketing', () => {
    beforeEach(() => {
      client.automaticEmail.findMany.mockResolvedValue([{ ...RULE, marketing: true }]);
    });

    it('holds back the unsubscribed and gives everyone else the link and header', async () => {
      findOccurrences.mockResolvedValue([occ(1), occ(2)]);
      applySuppressions.mockImplementation(async (list) => ({
        deliver: [{ ...list[0], marketing: true }],
        skipped: [{ ...list[1], marketing: true, skipReason: 'unsubscribed' }],
      }));

      expect(await runAutomaticEmails({ client })).toMatchObject({ sent: 1, suppressed: 1 });
      expect(sendEmail).toHaveBeenCalledTimes(1);
      const [, , html, , meta] = sendEmail.mock.calls[0];
      expect(html).toContain('Unsubscribe');
      expect(meta.listUnsubscribeUrl).toBe('https://x.test/one-click?e=p1@ucla.edu');
      expect(rows.find((r) => r.subjectKey === 'k2').status).toBe('SUPPRESSED');
    });

    it('gives staff no unsubscribe link, as every marketing send does', async () => {
      findOccurrences.mockResolvedValue([occ(1)]);
      applySuppressions.mockImplementation(async (list) => ({ deliver: [{ ...list[0], marketing: false }], skipped: [] }));

      await runAutomaticEmails({ client });
      expect(sendEmail.mock.calls[0][4].listUnsubscribeUrl).toBeNull();
    });
  });

  it('ignores the unsubscribe list for transactional email', async () => {
    findOccurrences.mockResolvedValue([occ(1)]);
    await runAutomaticEmails({ client });
    expect(applySuppressions).not.toHaveBeenCalled();
  });

  it('keeps going when one email is broken', async () => {
    client.automaticEmail.findMany.mockResolvedValue([{ ...RULE, id: 'broken' }, RULE]);
    findOccurrences.mockRejectedValueOnce(new Error('audience gone')).mockResolvedValueOnce([occ(1)]);

    expect((await runAutomaticEmails({ client })).sent).toBe(1);
  });

  it('does nothing when the tables do not exist yet', async () => {
    client.automaticEmail.findMany.mockRejectedValue(new Error('relation does not exist'));
    expect(await runAutomaticEmails({ client })).toEqual({ sent: 0, failed: 0, suppressed: 0 });
  });
});
