import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth, requireMember } from '../middleware/auth.js';
import memberRoutes from './member.js';

vi.mock('../services/releaseNotes.js', () => ({
  getMemberReleaseNotes: vi.fn(),
}));

vi.mock('../prismaClient.js', () => ({
  default: {
    user: {
      findUnique: vi.fn(),
    },
    $disconnect: vi.fn(),
  },
}));

import { getMemberReleaseNotes } from '../services/releaseNotes.js';
import prisma from '../prismaClient.js';

const memberUser = {
  id: 'member-1',
  role: 'MEMBER',
  isActive: true,
  email: 'member@example.com',
  fullName: 'Member User',
  graduationClass: null,
  studentId: null,
  profileImage: null,
  createdAt: new Date().toISOString(),
};

const adminUser = {
  id: 'admin-1',
  role: 'ADMIN',
  isActive: true,
  email: 'admin@example.com',
  fullName: 'Admin User',
  graduationClass: 'Spring 2025',
  studentId: null,
  profileImage: null,
  createdAt: new Date().toISOString(),
};

function tokenFor(user) {
  return jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
}

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/member', memberRoutes);
  return app;
}

describe('GET /api/member/release-notes', () => {
  let app;
  let server;

  beforeAll(() => {
    app = createTestApp();
    server = app.listen(0);
    return new Promise((resolve) => server.on('listening', resolve));
  });

  afterAll(() => {
    return new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.user.findUnique.mockImplementation(({ where: { id } }) => {
      if (id === memberUser.id) return memberUser;
      if (id === adminUser.id) return adminUser;
      return null;
    });
  });

  async function get(token) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`http://localhost:${server.address().port}/api/member/release-notes`, { headers });
  }

  it('returns release notes for a member', async () => {
    getMemberReleaseNotes.mockReturnValue([
      {
        id: 'note-1',
        releaseDate: '2026-07-28',
        title: 'Member release notes',
        summary: 'Summary',
        category: 'feature',
        affectedArea: 'Member experience',
        status: 'new',
        links: [],
      },
    ]);

    const res = await get(tokenFor(memberUser));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].id).toBe('note-1');
    expect(getMemberReleaseNotes).toHaveBeenCalledTimes(1);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await get(null);
    expect(res.status).toBe(401);
    expect(getMemberReleaseNotes).not.toHaveBeenCalled();
  });

  it('rejects non-member requests', async () => {
    const res = await get(tokenFor(adminUser));
    expect(res.status).toBe(403);
    expect(getMemberReleaseNotes).not.toHaveBeenCalled();
  });

  it('returns a 500 when the release notes source fails', async () => {
    getMemberReleaseNotes.mockImplementation(() => {
      throw new Error('Corrupted release notes file');
    });

    const res = await get(tokenFor(memberUser));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Failed to load release notes');
  });
});
