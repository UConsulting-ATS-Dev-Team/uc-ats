import { describe, it, expect, vi, beforeEach } from 'vitest';
import prisma from '../prismaClient.js';
import {
  listCandidateCommunications,
  phoneKey,
  summarizeCandidateCommunications,
} from './candidateCommunications.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    candidate: { findMany: vi.fn() },
    communicationLog: { findMany: vi.fn() },
    $queryRawUnsafe: vi.fn(),
  },
}));

const maria = {
  id: 'cand-maria',
  email: 'Maria@ucla.edu',
  applications: [
    { email: 'maria.personal@gmail.com', phoneNumber: '(310) 555-1234' },
    { email: 'Maria@ucla.edu', phoneNumber: '' },
  ],
  onboarding: { phoneNumber: '424.555.9876' },
};
const jo = { id: 'cand-jo', email: 'jo@g.ucla.edu', applications: [], onboarding: null };

// What the raw match query hands back: newest first.
const logRow = (id, address, { channel = 'email', phone = null, category = 'OTHER', status = 'SENT', sentAt = '2026-10-01T00:00:00Z' } = {}) =>
  ({ id, address, phone, channel, category, status, sentAt: new Date(sentAt) });

let matched;
let users;
const matchCalls = () => prisma.$queryRawUnsafe.mock.calls.filter(([sql]) => sql.includes('communication_logs'));

beforeEach(() => {
  vi.clearAllMocks();
  matched = [];
  prisma.candidate.findMany.mockImplementation(async ({ where }) =>
    [maria, jo].filter((c) => where.id.in.includes(c.id)));
  users = [];
  prisma.$queryRawUnsafe.mockImplementation(async (sql) => {
    if (sql.includes('FROM users')) return users;
    return sql.includes('count(*)') ? [{ total: matched.length }] : matched;
  });
  prisma.communicationLog.findMany.mockImplementation(async ({ where }) =>
    where.id.in.map((id) => ({ id, subject: `row ${id}` })));
});

describe('phoneKey', () => {
  it('compares numbers on their last ten digits', () => {
    expect(phoneKey('+1 (310) 555-1234')).toBe('3105551234');
    expect(phoneKey('3105551234')).toBe('3105551234');
    expect(phoneKey('555-1234')).toBeNull();
    expect(phoneKey(null)).toBeNull();
  });
});

describe('listCandidateCommunications', () => {
  it('searches every address the candidate is known by, in both UCLA spellings, and their numbers', async () => {
    users = [{ email: 'maria@ucla.edu', phoneNumber: '+13105550000' }];

    const result = await listCandidateCommunications('cand-maria');

    expect(new Set(result.matchedOn.emails)).toEqual(new Set([
      'maria@ucla.edu', 'maria@g.ucla.edu', 'maria.personal@gmail.com',
    ]));
    expect(new Set(result.matchedOn.phones)).toEqual(new Set(['3105551234', '4245559876', '3105550000']));

    const [userSql] = prisma.$queryRawUnsafe.mock.calls.find(([q]) => q.includes('FROM users'));
    expect(userSql).toContain('lower(email) = ANY($1::text[])');

    const [sql, emails, phones] = matchCalls()[0];
    expect(sql).toContain('lower(recipient) = ANY($1::text[])');
    expect(sql).toContain("channel = 'imessage'");
    expect(emails).toEqual(result.matchedOn.emails);
    expect(phones).toEqual(result.matchedOn.phones);
  });

  it('returns the full rows in the order the match query found them', async () => {
    matched = [logRow('b', 'maria@ucla.edu'), logRow('a', 'maria@g.ucla.edu')];
    prisma.communicationLog.findMany.mockResolvedValue([{ id: 'a' }, { id: 'b' }]);

    const result = await listCandidateCommunications('cand-maria');

    expect(result.rows.map((r) => r.id)).toEqual(['b', 'a']);
    expect(result.total).toBe(2);
  });

  it('pages through the match query', async () => {
    await listCandidateCommunications('cand-maria', { limit: '10', offset: '20' });

    const [sql, , , limit, offset] = matchCalls()[0];
    expect(sql).toContain('LIMIT $3 OFFSET $4');
    expect([limit, offset]).toEqual([10, 20]);
  });

  it('is null for a candidate that does not exist', async () => {
    expect(await listCandidateCommunications('nobody')).toBeNull();
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
  });
});

describe('summarizeCandidateCommunications', () => {
  it('counts each candidate’s messages and reports the latest, from one query', async () => {
    matched = [
      logRow('3', 'maria@g.ucla.edu', { category: 'APPLICATION_RECEIVED', sentAt: '2026-10-02T00:00:00Z' }),
      logRow('2', 'jo@ucla.edu', { category: 'EVENT', sentAt: '2026-09-30T00:00:00Z' }),
      logRow('1', 'someone', { channel: 'imessage', phone: '3105551234', category: 'MEETING', sentAt: '2026-09-01T00:00:00Z' }),
    ];

    const summary = await summarizeCandidateCommunications(['cand-maria', 'cand-jo']);

    expect(matchCalls().filter(([sql]) => !sql.includes('count(*)'))).toHaveLength(1);
    expect(summary['cand-maria']).toEqual({
      total: 2,
      latest: { category: 'APPLICATION_RECEIVED', channel: 'email', status: 'SENT', sentAt: new Date('2026-10-02T00:00:00Z') },
    });
    expect(summary['cand-jo'].total).toBe(1);
    expect(summary['cand-jo'].latest.category).toBe('EVENT');
  });

  it('matches a phone number only on iMessage rows', async () => {
    matched = [logRow('1', 'x', { channel: 'email', phone: '3105551234' })];

    const summary = await summarizeCandidateCommunications(['cand-maria']);

    expect(summary['cand-maria'].total).toBe(0);
  });

  it('answers every requested candidate, including ones with nothing sent', async () => {
    const summary = await summarizeCandidateCommunications(['cand-jo']);
    expect(summary).toEqual({ 'cand-jo': { total: 0, latest: null } });
  });

  it('answers 400 for anything but an array of ids', async () => {
    for (const bad of ['cand-maria', { id: 'cand-maria' }, undefined, null]) {
      await expect(summarizeCandidateCommunications(bad)).rejects.toMatchObject({ status: 400 });
    }
  });

  it('refuses more than a page of candidates', async () => {
    const ids = Array.from({ length: 201 }, (_, i) => `c${i}`);
    await expect(summarizeCandidateCommunications(ids)).rejects.toMatchObject({ status: 400 });
  });
});
