import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import adminRoutes from './admin.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    recruitingCycle: { findFirst: vi.fn() },
  }
}));

const adminUser = {
  id: 'admin-1',
  role: 'ADMIN',
  email: 'admin@example.com',
  fullName: 'Admin User',
  graduationClass: 'Spring 2025'
};

const memberUser = {
  id: 'member-1',
  role: 'MEMBER',
  email: 'member@example.com',
  fullName: 'Member User',
  graduationClass: null
};

function tokenFor(user) {
  return jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
}

describe('GET /api/admin/users', () => {
  let app;
  let server;
  let port;

  beforeAll(async () => {
    app = express();
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
    prisma.user.findUnique.mockImplementation(({ where: { id } }) => {
      if (id === adminUser.id) return adminUser;
      if (id === memberUser.id) return memberUser;
      return null;
    });
    prisma.user.findMany.mockResolvedValue([]);
  });

  async function get(token = tokenFor(adminUser), query = {}) {
    const qs = new URLSearchParams(query).toString();
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`http://localhost:${port}/api/admin/users${qs ? '?' + qs : ''}`, { headers });
  }

  it('returns users for an admin', async () => {
    prisma.user.findMany.mockResolvedValue([adminUser, memberUser]);

    const res = await get();

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await get(null);
    expect(res.status).toBe(401);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('rejects non-admin requests', async () => {
    const res = await get(tokenFor(memberUser));
    expect(res.status).toBe(403);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('filters by role', async () => {
    await get(tokenFor(adminUser), { role: 'MEMBER' });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ role: 'MEMBER' })
      })
    );
  });

  it('maps INTERVIEWER role to MEMBER', async () => {
    await get(tokenFor(adminUser), { role: 'INTERVIEWER' });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ role: 'MEMBER' })
      })
    );
  });

  it('filters by graduation class', async () => {
    await get(tokenFor(adminUser), { graduationClass: 'Fall 2024' });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ graduationClass: 'Fall 2024' })
      })
    );
  });

  it('filters by missing graduation class using the sentinel value', async () => {
    await get(tokenFor(adminUser), { graduationClass: '__UNKNOWN_GRADUATION_CLASS__' });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { graduationClass: null },
            { graduationClass: '' }
          ]
        })
      })
    );
  });

  it('composes role and graduation class filters', async () => {
    await get(tokenFor(adminUser), { role: 'MEMBER', graduationClass: 'Spring 2025' });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          role: 'MEMBER',
          graduationClass: 'Spring 2025'
        })
      })
    );
  });

  it('composes role and missing graduation class filters', async () => {
    await get(tokenFor(adminUser), { role: 'MEMBER', graduationClass: '__UNKNOWN_GRADUATION_CLASS__' });

    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          role: 'MEMBER',
          OR: [
            { graduationClass: null },
            { graduationClass: '' }
          ]
        })
      })
    );
  });

  it('returns 400 for an invalid graduation class type', async () => {
    const res = await get(tokenFor(adminUser), 'graduationClass=bad&graduationClass=worse');
    expect(res.status).toBe(400);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('returns 400 for an excessively long graduation class', async () => {
    const longClass = 'a'.repeat(101);
    const res = await get(tokenFor(adminUser), { graduationClass: longClass });
    expect(res.status).toBe(400);
    expect(prisma.user.findMany).not.toHaveBeenCalled();
  });

  it('ignores an empty graduation class query value', async () => {
    const res = await get(tokenFor(adminUser), { graduationClass: '' });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual([]);
  });

  async function getClasses(token = tokenFor(adminUser), query = {}) {
    const qs = new URLSearchParams(query).toString();
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`http://localhost:${port}/api/admin/users/classes${qs ? '?' + qs : ''}`, { headers });
  }

  describe('GET /api/admin/users/classes', () => {
    it('returns class options and counts for an admin', async () => {
      prisma.user.findMany.mockResolvedValue([
        { graduationClass: 'Fall 2024' },
        { graduationClass: 'Fall 2024' },
        { graduationClass: 'Spring 2025' },
        { graduationClass: '' },
        { graduationClass: null },
        { graduationClass: '  ' }
      ]);

      const res = await getClasses();
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.total).toBe(6);
      expect(body.classes).toEqual([
        { value: 'Fall 2024', label: 'Fall 2024', count: 2 },
        { value: 'Spring 2025', label: 'Spring 2025', count: 1 }
      ]);
      expect(body.unknown).toEqual({
        value: '__UNKNOWN_GRADUATION_CLASS__',
        label: 'Unknown / No class',
        count: 3
      });
    });

    it('rejects unauthenticated requests', async () => {
      const res = await getClasses(null);
      expect(res.status).toBe(401);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('rejects non-admin requests', async () => {
      const res = await getClasses(tokenFor(memberUser));
      expect(res.status).toBe(403);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('composes role filter but ignores the graduation class filter', async () => {
      prisma.user.findMany.mockResolvedValue([
        { role: 'MEMBER', graduationClass: 'Fall 2024' },
        { role: 'MEMBER', graduationClass: null }
      ]);

      const res = await getClasses(tokenFor(adminUser), { role: 'MEMBER', graduationClass: 'Fall 2024' });
      expect(res.status).toBe(200);
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ role: 'MEMBER' }),
          select: { graduationClass: true }
        })
      );
      const body = await res.json();
      expect(body.total).toBe(2);
      expect(body.classes).toHaveLength(1);
      expect(body.unknown.count).toBe(1);
    });
  });
});
