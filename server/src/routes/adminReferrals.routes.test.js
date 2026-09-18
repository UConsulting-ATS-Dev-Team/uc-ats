// The admin side of referrals: the queue of ones that could not attach
// themselves, and matching them by hand.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import adminRoutes from './admin.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() },
    recruitingCycle: { findFirst: vi.fn() },
    candidate: { findUnique: vi.fn(), findMany: vi.fn() },
    referral: { findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() }
  }
}));

const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'a@uc.org', fullName: 'Admin' };
const memberUser = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'm@uc.org', fullName: 'Member' };
const ALL_USERS = [adminUser, memberUser];

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

const pending = {
  id: 'ref-1',
  referrerName: 'Pam Beesly',
  relationship: 'Classmate',
  source: 'PRE_APPLICATION',
  referredFirstName: 'Karen',
  referredLastName: 'Filippelli',
  candidateId: null,
  claimedAt: null,
  createdAt: new Date('2026-09-01'),
  candidate: null,
  referredBy: { id: 'member-1', fullName: 'Pam Beesly', email: 'm@uc.org' }
};

beforeAll(async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret';
  const app = express();
  app.use(express.json());
  app.use('/api/admin', adminRoutes);
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
  prisma.candidate.findMany.mockResolvedValue([]);
  prisma.candidate.findUnique.mockResolvedValue({ id: 'cand-1', recordsLockedAt: null });
  prisma.referral.findMany.mockResolvedValue([]);
  prisma.referral.findUnique.mockResolvedValue({ id: 'ref-1', candidateId: null });
  prisma.referral.update.mockImplementation(({ data }) => ({ id: 'ref-1', ...data }));
});

describe('GET /api/admin/referrals', () => {
  it('refuses a member - this is the admin queue', async () => {
    const res = await request('/api/admin/referrals', { user: memberUser });
    expect(res.status).toBe(403);
  });

  it('filters to the ones still waiting on a person', async () => {
    await request('/api/admin/referrals?status=PENDING', { user: adminUser });
    expect(prisma.referral.findMany.mock.calls[0][0].where).toEqual({
      cycleId: activeCycle.id,
      candidateId: null
    });
  });

  it('filters to the ones already attached', async () => {
    await request('/api/admin/referrals?status=ATTACHED', { user: adminUser });
    expect(prisma.referral.findMany.mock.calls[0][0].where).toEqual({
      cycleId: activeCycle.id,
      candidateId: { not: null }
    });
  });

  it('reports each row as pending or attached', async () => {
    prisma.referral.findMany.mockResolvedValue([pending]);
    const res = await request('/api/admin/referrals', { user: adminUser });
    const [row] = await res.json();

    expect(row.status).toBe('PENDING');
    expect(row.referredName).toBe('Karen Filippelli');
  });

  it('returns nothing rather than erroring when no cycle is open', async () => {
    prisma.recruitingCycle.findFirst.mockResolvedValue(null);
    const res = await request('/api/admin/referrals', { user: adminUser });
    expect(await res.json()).toEqual([]);
  });
});

describe('PATCH /api/admin/referrals/:id', () => {
  it('attaches the referral to the candidate an admin picked', async () => {
    const res = await request('/api/admin/referrals/ref-1', {
      user: adminUser,
      method: 'PATCH',
      body: { candidateId: 'cand-1' }
    });

    expect(res.status).toBe(200);
    const { data } = prisma.referral.update.mock.calls[0][0];
    expect(data.candidateId).toBe('cand-1');
    expect(data.claimedAt).toBeInstanceOf(Date);
  });

  it('requires a candidate to attach to', async () => {
    const res = await request('/api/admin/referrals/ref-1', {
      user: adminUser,
      method: 'PATCH',
      body: { candidateId: '   ' }
    });
    expect(res.status).toBe(400);
  });

  it('answers 423 rather than writing to a sealed record', async () => {
    prisma.candidate.findUnique.mockResolvedValue({ id: 'cand-1', recordsLockedAt: new Date() });

    const res = await request('/api/admin/referrals/ref-1', {
      user: adminUser,
      method: 'PATCH',
      body: { candidateId: 'cand-1' }
    });

    expect(res.status).toBe(423);
    expect(prisma.referral.update).not.toHaveBeenCalled();
  });

  it('refuses a member', async () => {
    const res = await request('/api/admin/referrals/ref-1', {
      user: memberUser,
      method: 'PATCH',
      body: { candidateId: 'cand-1' }
    });
    expect(res.status).toBe(403);
  });
});

describe('GET /api/admin/referral-candidates', () => {
  it('needs at least two letters', async () => {
    const res = await request('/api/admin/referral-candidates?q=k', { user: adminUser });
    expect(await res.json()).toEqual([]);
    expect(prisma.candidate.findMany).not.toHaveBeenCalled();
  });

  it('searches every cycle, since a referral may belong to an older applicant', async () => {
    await request('/api/admin/referral-candidates?q=kar', { user: adminUser });
    const { where } = prisma.candidate.findMany.mock.calls[0][0];

    expect(where.applications).toBeUndefined();
    expect(where.recordsLockedAt).toBeNull();
  });
});
