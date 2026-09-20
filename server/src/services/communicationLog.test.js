// The communications log is an audit record, so the two properties that matter
// are that it never breaks a send and that what it stores is readable.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import {
  redactSecrets,
  toBodyPreview,
  recordCommunication,
  recordCommunications,
  listCommunications,
} from './communicationLog.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    communicationLog: {
      create: vi.fn(),
      upsert: vi.fn(),
      createMany: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      groupBy: vi.fn(),
    },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  prisma.communicationLog.create.mockResolvedValue({ id: 'log-1' });
  prisma.communicationLog.upsert.mockResolvedValue({ id: 'log-1' });
  prisma.communicationLog.createMany.mockResolvedValue({ count: 0 });
  prisma.communicationLog.findMany.mockResolvedValue([]);
  prisma.communicationLog.count.mockResolvedValue(0);
});

const dataOf = () => prisma.communicationLog.create.mock.calls[0][0].data;
const whereOf = () => prisma.communicationLog.findMany.mock.calls[0][0].where;

describe('toBodyPreview', () => {
  it('reduces an HTML body to the text a person would read', () => {
    expect(toBodyPreview('<p>Hi <strong>Ryan</strong></p><p>You are in.</p>')).toBe(
      'Hi Ryan\n\nYou are in.'
    );
  });

  it('unescapes the entities the templates escape on the way in', () => {
    expect(toBodyPreview('<p>Tools &amp; Tactics &lt;3</p>')).toBe('Tools & Tactics <3');
  });

  it('drops script and style content rather than reading it out', () => {
    expect(toBodyPreview('<style>p{color:red}</style><p>Body</p>')).toBe('Body');
  });

  it('caps a long body instead of storing the whole letter twice', () => {
    const preview = toBodyPreview('x'.repeat(5000));
    expect(preview).toHaveLength(2001);
    expect(preview.endsWith('…')).toBe(true);
  });

  it('answers null for nothing at all', () => {
    expect(toBodyPreview('')).toBeNull();
    expect(toBodyPreview(null)).toBeNull();
    expect(toBodyPreview('<p>   </p>')).toBeNull();
  });
});

describe('recordCommunication', () => {
  it('stores the send with a readable preview of the body', async () => {
    await recordCommunication({
      recipient: 'ryan@example.com',
      subject: 'You are in',
      body: '<p>Congratulations</p>',
      category: 'APPLICATION_DECISION',
    });
    expect(dataOf()).toMatchObject({
      channel: 'email',
      recipient: 'ryan@example.com',
      subject: 'You are in',
      bodyPreview: 'Congratulations',
      category: 'APPLICATION_DECISION',
      trigger: 'AUTOMATED',
      status: 'SENT',
    });
  });

  // The whole point: a mail that actually went out must not be reported as a
  // failure because the audit row would not write.
  it('swallows a database failure rather than failing the send', async () => {
    prisma.communicationLog.create.mockRejectedValue(new Error('connection lost'));
    await expect(recordCommunication({ recipient: 'a@b.com' })).resolves.toBeNull();
  });

  it('writes nothing when there is no recipient to write about', async () => {
    await recordCommunication({ subject: 'orphan' });
    expect(prisma.communicationLog.create).not.toHaveBeenCalled();
  });
});

describe('recordCommunications', () => {
  it('skips entries with no recipient and writes the rest in one call', async () => {
    prisma.communicationLog.createMany.mockResolvedValue({ count: 2 });
    const written = await recordCommunications([
      { recipient: 'a@b.com' },
      { recipient: '' },
      null,
      { recipient: 'c@d.com' },
    ]);
    expect(written).toBe(2);
    expect(prisma.communicationLog.createMany.mock.calls[0][0].data).toHaveLength(2);
  });

  it('does not go to the database for an empty batch', async () => {
    expect(await recordCommunications([])).toBe(0);
    expect(prisma.communicationLog.createMany).not.toHaveBeenCalled();
  });
});

describe('listCommunications', () => {
  it('asks for everything, newest first, when given no filters', async () => {
    await listCommunications();
    const call = prisma.communicationLog.findMany.mock.calls[0][0];
    expect(call.where).toEqual({});
    expect(call.orderBy).toEqual({ sentAt: 'desc' });
  });

  it('searches recipient, name and subject together', async () => {
    await listCommunications({ search: '  Ryan  ' });
    expect(whereOf().OR).toEqual([
      { recipient: { contains: 'Ryan', mode: 'insensitive' } },
      { recipientName: { contains: 'Ryan', mode: 'insensitive' } },
      { subject: { contains: 'Ryan', mode: 'insensitive' } },
    ]);
  });

  it('ignores a blank search rather than matching everything twice', async () => {
    await listCommunications({ search: '   ' });
    expect(whereOf().OR).toBeUndefined();
  });

  it('turns a date range into one bounded sentAt filter', async () => {
    await listCommunications({ from: '2026-09-01', to: '2026-09-30' });
    expect(whereOf().sentAt.gte).toEqual(new Date('2026-09-01'));
    // Exclusive, one day on: see "the end of a date range" below.
    expect(whereOf().sentAt.lt).toEqual(new Date('2026-10-01'));
  });

  it('drops an unparseable date instead of filtering on Invalid Date', async () => {
    await listCommunications({ from: 'not-a-date' });
    expect(whereOf().sentAt).toBeUndefined();
  });

  it('caps the page size so one request cannot pull the whole table', async () => {
    await listCommunications({ limit: 100000 });
    expect(prisma.communicationLog.findMany.mock.calls[0][0].take).toBe(200);
  });

  it('reports the unpaged total alongside the page', async () => {
    prisma.communicationLog.findMany.mockResolvedValue([{ id: 'a' }]);
    prisma.communicationLog.count.mockResolvedValue(412);
    const result = await listCommunications({ limit: 1 });
    expect(result).toMatchObject({ total: 412, limit: 1, offset: 0 });
    expect(result.rows).toHaveLength(1);
  });
});

// A password-reset mail renders its link as visible text, so the preview would
// otherwise hand any admin a working token for somebody else's account.
describe('redacting credentials', () => {
  it('strips a password-reset token but keeps the address recognisable', () => {
    expect(redactSecrets('Reset here: https://app.uc.org/reset-password?token=abc123XYZ')).toBe(
      'Reset here: https://app.uc.org/reset-password?token=[redacted]'
    );
  });

  it('strips an email-verification token', () => {
    expect(redactSecrets('https://app.uc.org/verify-email?token=deadbeef')).toBe(
      'https://app.uc.org/verify-email?token=[redacted]'
    );
  });

  it('leaves ordinary query parameters alone', () => {
    expect(redactSecrets('https://app.uc.org/events?cycle=fall-2026&page=2')).toBe(
      'https://app.uc.org/events?cycle=fall-2026&page=2'
    );
  });

  it('strips a token that is not the first parameter', () => {
    expect(redactSecrets('https://app.uc.org/x?a=1&token=secret&b=2')).toBe(
      'https://app.uc.org/x?a=1&token=[redacted]&b=2'
    );
  });

  it('runs as part of building a preview, not only on demand', () => {
    const preview = toBodyPreview(
      '<p>Click <a href="https://app.uc.org/reset-password?token=abc">here</a>: ' +
        'https://app.uc.org/reset-password?token=abc</p>'
    );
    expect(preview).not.toContain('token=abc');
    expect(preview).toContain('token=[redacted]');
  });

  it('redacts a preview a caller supplies ready-made', async () => {
    await recordCommunication({
      recipient: 'ryan@example.com',
      bodyPreview: 'go to https://app.uc.org/reset-password?token=abc',
    });
    expect(dataOf().bodyPreview).toBe('go to https://app.uc.org/reset-password?token=[redacted]');
  });
});

// The senders retry up to three times. Without a key, one message left a FAILED
// row beside its SENT one and the log stopped being one row per recipient.
describe('retries', () => {
  it('upserts on the attempt key rather than inserting a second row', async () => {
    await recordCommunication({
      recipient: 'ryan@example.com',
      attemptKey: 'decision-message:dm-1|ryan@example.com',
      status: 'SENT',
    });
    expect(prisma.communicationLog.create).not.toHaveBeenCalled();
    const call = prisma.communicationLog.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ attemptKey: 'decision-message:dm-1|ryan@example.com' });
    expect(call.update).toMatchObject({ status: 'SENT' });
  });

  it('moves the timestamp forward when a retry overwrites the earlier attempt', async () => {
    await recordCommunication({ recipient: 'a@b.com', attemptKey: 'k' });
    expect(prisma.communicationLog.upsert.mock.calls[0][0].update.sentAt).toBeInstanceOf(Date);
  });

  it('still plainly inserts when nothing retries the send', async () => {
    await recordCommunication({ recipient: 'a@b.com' });
    expect(prisma.communicationLog.create).toHaveBeenCalled();
    expect(prisma.communicationLog.upsert).not.toHaveBeenCalled();
  });
});

// The picker sends YYYY-MM-DD, which parses to the start of that day.
describe('the end of a date range', () => {
  it('includes the whole day the admin picked', async () => {
    await listCommunications({ to: '2026-09-20' });
    expect(whereOf().sentAt).toEqual({ lt: new Date('2026-09-21T00:00:00.000Z') });
  });

  it('takes a full timestamp at its word', async () => {
    await listCommunications({ to: '2026-09-20T12:00:00.000Z' });
    expect(whereOf().sentAt).toEqual({ lt: new Date('2026-09-20T12:00:00.000Z') });
  });
});
