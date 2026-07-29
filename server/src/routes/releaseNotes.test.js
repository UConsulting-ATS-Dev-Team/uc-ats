import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import releaseNotesRoutes from './releaseNotes.js';

vi.mock('../services/releaseNotes.js', () => ({
  getReleaseNotes: vi.fn(),
}));

vi.mock('../prismaClient.js', () => ({
  default: {
    user: {
      findUnique: vi.fn(),
    },
    $disconnect: vi.fn(),
  },
}));

import { getReleaseNotes } from '../services/releaseNotes.js';
import prisma from '../prismaClient.js';

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

function tokenFor(user) {
  return jwt.sign({ userId: user.id }, process.env.JWT_SECRET);
}

function createTestApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/admin/release-notes', requireAuth, requireAdmin, releaseNotesRoutes);
  return app;
}

describe('GET /api/admin/release-notes', () => {
  let app;
  let server;
  let port;

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
      if (id === adminUser.id) return adminUser;
      if (id === memberUser.id) return memberUser;
      return null;
    });
  });

  async function get(token) {
    const headers = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`http://localhost:${server.address().port}/api/admin/release-notes`, { headers });
  }

  it('returns release notes for an admin', async () => {
    getReleaseNotes.mockReturnValue([
      {
        id: 'note-2',
        releaseDate: '2025-07-28',
        title: 'Admin release notes',
        summary: 'Summary two',
        category: 'feature',
        affectedArea: 'Admin',
        status: 'new',
        links: [],
      },
      {
        id: 'note-1',
        releaseDate: '2025-07-20',
        title: 'Older note',
        summary: 'Summary one',
        category: 'fix',
        affectedArea: 'Grading',
        status: 'resolved',
        links: [],
      },
    ]);

    const res = await get(tokenFor(adminUser));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(2);
    expect(body[0].id).toBe('note-2');
    expect(body[1].id).toBe('note-1');
    expect(getReleaseNotes).toHaveBeenCalledTimes(1);
  });

  it('rejects unauthenticated requests', async () => {
    const res = await get(null);
    expect(res.status).toBe(401);
    expect(getReleaseNotes).not.toHaveBeenCalled();
  });

  it('rejects non-admin requests', async () => {
    const res = await get(tokenFor(memberUser));
    expect(res.status).toBe(403);
    expect(getReleaseNotes).not.toHaveBeenCalled();
  });

  it('returns a 500 when the release notes source fails', async () => {
    getReleaseNotes.mockImplementation(() => {
      throw new Error('Corrupted release notes file');
    });

    const res = await get(tokenFor(adminUser));

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Failed to load release notes');
  });
});
