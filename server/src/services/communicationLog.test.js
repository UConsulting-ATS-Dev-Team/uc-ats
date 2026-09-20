// The communications log is an audit record, so the two properties that matter
// are that it never breaks a send and that what it stores is readable.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import {
  toBodyPreview,
  recordCommunication,
  recordCommunications,
  listCommunications,
} from './communicationLog.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    communicationLog: {
      create: vi.fn(),
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
    expect(whereOf().sentAt.lte).toEqual(new Date('2026-09-30'));
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
