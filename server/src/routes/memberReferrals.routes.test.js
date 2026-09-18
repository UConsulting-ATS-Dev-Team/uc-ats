// Member-submitted referrals for people who have not applied yet.
//
// The assertions worth having: a member cannot submit a referral we could never
// match on (a half name), a candidate cannot submit one at all, and the list a
// member reads back says whether their referral has found its person - without
// linking through to a sealed record.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import memberRoutes from './member.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    recruitingCycle: { findFirst: vi.fn() },
    candidate: { findFirst: vi.fn(), findMany: vi.fn() },
    referral: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn() }
  }
}));

const memberUser = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'm@uc.org', fullName: 'Pam Beesly' };
const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'a@uc.org', fullName: 'Admin' };
const candidateUser = { id: 'user-1', role: 'USER', isActive: true, email: 'c@uc.org', fullName: 'Applicant' };
const ALL_USERS = [memberUser, adminUser, candidateUser];

const activeCycle = { id: 'cycle-1', name: 'Fall 2026', isActive: true };

const tokenFor = (user) => jwt.sign({ userId: user.id }, process.env.JWT_SECRET);

let server;
let port;

const request = (path, { user, method = 'GET', body } = {}) => {
  const headers = {};
  if (user) headers.Authorization = `Bearer ${tokenFor(user)}`;
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(`http://localhost:${port}${path}`, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {})
  });
};

const validBody = {
  referredFirstName: 'Karen',
  referredLastName: 'Filippelli',
  relationship: 'Classmate'
};

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const app = express();
  app.use(express.json());
  app.use('/api/member', memberRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockImplementation(({ where: { id } }) => ALL_USERS.find((u) => u.id === id) || null);
  prisma.recruitingCycle.findFirst.mockResolvedValue(activeCycle);
  prisma.candidate.findFirst.mockResolvedValue(null);
  prisma.candidate.findMany.mockResolvedValue([]);
  prisma.referral.findFirst.mockResolvedValue(null);
  prisma.referral.findMany.mockResolvedValue([]);
  prisma.referral.create.mockImplementation(({ data }) => ({ id: 'ref-new', ...data }));
});

describe('POST /api/member/referrals gating', () => {
  it('refuses a candidate - referrals are a members-only endorsement', async () => {
    const res = await request('/api/member/referrals', { user: candidateUser, method: 'POST', body: validBody });
    expect(res.status).toBe(403);
  });

  it('refuses an unauthenticated request', async () => {
    const res = await request('/api/member/referrals', { method: 'POST', body: validBody });
    expect(res.status).toBe(401);
  });

  it('allows an admin, who is also a person who knows people', async () => {
    const res = await request('/api/member/referrals', { user: adminUser, method: 'POST', body: validBody });
    expect(res.status).toBe(201);
  });
});

describe('POST /api/member/referrals validation', () => {
  it('refuses a half name, which could never be matched', async () => {
    for (const body of [
      { ...validBody, referredLastName: '' },
      { ...validBody, referredFirstName: '   ' },
      { ...validBody, referredFirstName: undefined }
    ]) {
      const res = await request('/api/member/referrals', { user: memberUser, method: 'POST', body });
      expect(res.status).toBe(400);
    }
    expect(prisma.referral.create).not.toHaveBeenCalled();
  });

  it('requires a relationship, so the referral says something', async () => {
    const res = await request('/api/member/referrals', {
      user: memberUser,
      method: 'POST',
      body: { ...validBody, relationship: '  ' }
    });
    expect(res.status).toBe(400);
  });

  it('refuses an overlong field rather than truncating it', async () => {
    const res = await request('/api/member/referrals', {
      user: memberUser,
      method: 'POST',
      body: { ...validBody, referredFirstName: 'a'.repeat(121) }
    });
    expect(res.status).toBe(400);
  });

  it('refuses when no cycle is open to refer into', async () => {
    prisma.recruitingCycle.findFirst.mockResolvedValue(null);
    const res = await request('/api/member/referrals', { user: memberUser, method: 'POST', body: validBody });
    expect(res.status).toBe(409);
  });

  it('reports the member\'s own second submission as a conflict, not a new referral', async () => {
    prisma.referral.findFirst.mockResolvedValue({ id: 'ref-existing' });
    const res = await request('/api/member/referrals', { user: memberUser, method: 'POST', body: validBody });
    expect(res.status).toBe(409);
    expect(prisma.referral.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/member/referrals records the submission', () => {
  it('stores it pending, in the active cycle, attributed to the member', async () => {
    const res = await request('/api/member/referrals', { user: memberUser, method: 'POST', body: validBody });
    expect(res.status).toBe(201);

    const { data } = prisma.referral.create.mock.calls[0][0];
    expect(data).toMatchObject({
      referrerName: 'Pam Beesly',
      relationship: 'Classmate',
      source: 'PRE_APPLICATION',
      referredFirstName: 'Karen',
      referredLastName: 'Filippelli',
      referredByUserId: memberUser.id,
      cycleId: activeCycle.id,
      candidateId: null
    });
    expect(data.referredNameKey).toBe('karen|filippelli');
  });

  it('trims what the member typed', async () => {
    await request('/api/member/referrals', {
      user: memberUser,
      method: 'POST',
      body: { referredFirstName: '  Karen ', referredLastName: ' Filippelli  ', relationship: ' Classmate ' }
    });

    const { data } = prisma.referral.create.mock.calls[0][0];
    expect(data.referredFirstName).toBe('Karen');
    expect(data.referredLastName).toBe('Filippelli');
    expect(data.relationship).toBe('Classmate');
  });

  it('attaches straight away when that person already applied', async () => {
    prisma.candidate.findFirst.mockResolvedValue({ id: 'cand-7' });
    const res = await request('/api/member/referrals', { user: memberUser, method: 'POST', body: validBody });
    expect(res.status).toBe(201);

    const { data } = prisma.referral.create.mock.calls[0][0];
    expect(data.candidateId).toBe('cand-7');
    expect(data.claimedAt).toBeInstanceOf(Date);
  });
});

describe('GET /api/member/referrals', () => {
  const pending = {
    id: 'ref-1',
    relationship: 'Classmate',
    referredFirstName: 'Karen',
    referredLastName: 'Filippelli',
    candidateId: null,
    claimedAt: null,
    createdAt: new Date('2026-09-01'),
    cycle: activeCycle,
    candidate: null
  };
  const attached = {
    id: 'ref-2',
    relationship: 'Teammate',
    referredFirstName: 'Mike',
    referredLastName: 'Scott',
    candidateId: 'cand-3',
    claimedAt: new Date('2026-09-05'),
    createdAt: new Date('2026-09-02'),
    cycle: activeCycle,
    candidate: { id: 'cand-3', firstName: 'Michael', lastName: 'Scott' }
  };

  it('returns only this member\'s referrals', async () => {
    await request('/api/member/referrals', { user: memberUser });
    expect(prisma.referral.findMany.mock.calls[0][0].where).toEqual({ referredByUserId: memberUser.id });
  });

  it('says which referrals found their person', async () => {
    prisma.referral.findMany.mockResolvedValue([attached, pending]);
    const res = await request('/api/member/referrals', { user: memberUser });
    const body = await res.json();

    expect(body.map((r) => [r.referredName, r.status])).toEqual([
      ['Michael Scott', 'ATTACHED'],
      ['Karen Filippelli', 'PENDING']
    ]);
  });

  it('drops the link through to a sealed candidate but keeps the referral', async () => {
    prisma.referral.findMany.mockResolvedValue([attached]);
    prisma.candidate.findMany.mockResolvedValue([{ id: 'cand-3', studentId: null, email: null }]);

    const res = await request('/api/member/referrals', { user: memberUser });
    const [row] = await res.json();

    expect(row.status).toBe('ATTACHED');
    expect(row.candidateId).toBeNull();
  });

  it('refuses a candidate', async () => {
    const res = await request('/api/member/referrals', { user: candidateUser });
    expect(res.status).toBe(403);
  });
});
