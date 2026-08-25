// The containment proof for the CLIENT role.
//
// A sentinel catch-all sits behind the middleware and answers 200 for any path.
// Reaching it means the middleware let the request through. That tests the
// containment rule itself rather than the role gates of whichever routers
// happen to exist today - so a route file added next month is covered by these
// assertions without anyone remembering to update them.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import externalContainment from './externalContainment.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() }
  }
}));

const adminUser = { id: 'admin-1', role: 'ADMIN', isActive: true, email: 'a@example.com', fullName: 'Admin' };
const memberUser = { id: 'member-1', role: 'MEMBER', isActive: true, email: 'm@example.com', fullName: 'Member' };
const candidateUser = { id: 'user-1', role: 'USER', isActive: true, email: 'c@example.com', fullName: 'Candidate' };
const clientUser = { id: 'client-1', role: 'CLIENT', isActive: true, email: 'p@partner.com', fullName: 'Partner Co' };
const deactivatedClient = { id: 'client-2', role: 'CLIENT', isActive: false, email: 'x@partner.com', fullName: 'Ex Partner' };

const ALL_USERS = [adminUser, memberUser, candidateUser, clientUser, deactivatedClient];

const tokenFor = (user) => jwt.sign({ userId: user.id }, process.env.JWT_SECRET);

let server;
let port;

const request = (path, { user, rawToken } = {}) => {
  const headers = {};
  if (user) headers.Authorization = `Bearer ${tokenFor(user)}`;
  if (rawToken) headers.Authorization = `Bearer ${rawToken}`;
  return fetch(`http://localhost:${port}${path}`, { headers });
};

// Every path a CLIENT must be shut out of. Deliberately spans the route files
// that mount a bare requireAuth with no role gate of their own - those are the
// ones this middleware exists for.
const FORBIDDEN_PATHS = [
  '/api/users',
  '/api/users/admin-1',
  '/api/files/some-drive-id/pdf',
  '/api/files/some-drive-id/image',
  '/api/applications',
  '/api/applications/app-1',
  '/api/admin/users',
  '/api/admin/talent-pool/stats',
  '/api/member/gtkuc-profile',
  '/api/member/resume',
  '/api/candidates',
  '/api/feature-requests',
  '/api/cases/case-1',
  '/api/review-teams',
  '/api/conversations',
  '/api/interview-resources',
  '/api/my-meeting-signups'
];

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(externalContainment);
  // Sentinel: anything that gets past containment lands here.
  app.use((req, res) => res.status(200).json({ reached: true, path: req.path }));
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockImplementation(({ where: { id } }) =>
    ALL_USERS.find((u) => u.id === id) || null
  );
});

describe('externalContainment - CLIENT is confined to the portal', () => {
  it('blocks a CLIENT on every non-portal API path', async () => {
    const results = await Promise.all(
      FORBIDDEN_PATHS.map(async (path) => {
        const res = await request(path, { user: clientUser });
        return { path, status: res.status, body: await res.json() };
      })
    );

    for (const { path, status, body } of results) {
      expect({ path, status }).toEqual({ path, status: 403 });
      expect(body.error).toBe('This account does not have access to that area');
      expect(body.reached).toBeUndefined();
    }
  });

  it('lets a CLIENT through to the portal and to login/verify/health', async () => {
    const allowed = [
      '/api/client/me',
      '/api/client/resumes',
      '/api/client/resumes/assignment-1/pdf',
      '/api/auth/login',
      '/api/auth/verify',
      '/api/health'
    ];

    const results = await Promise.all(
      allowed.map(async (path) => ({ path, status: (await request(path, { user: clientUser })).status }))
    );

    expect(results).toEqual(allowed.map((path) => ({ path, status: 200 })));
  });

  it('does not treat /api/clientele as a portal path', async () => {
    // The prefix check is '/api/client/' with the trailing slash for exactly
    // this reason - '/api/client' must not become a wildcard.
    const res = await request('/api/clientele/secrets', { user: clientUser });
    expect(res.status).toBe(403);
  });
});

describe('externalContainment - transparent to everyone else', () => {
  it('leaves ADMIN, MEMBER and USER untouched on every path a CLIENT is blocked from', async () => {
    for (const user of [adminUser, memberUser, candidateUser]) {
      const results = await Promise.all(
        FORBIDDEN_PATHS.map(async (path) => ({
          path,
          status: (await request(path, { user })).status
        }))
      );
      expect({ role: user.role, results }).toEqual({
        role: user.role,
        results: FORBIDDEN_PATHS.map((path) => ({ path, status: 200 }))
      });
    }
  });

  it('passes unauthenticated requests through so downstream still answers 401, not 403', async () => {
    const res = await request('/api/users');
    expect(res.status).toBe(200); // reached the sentinel; containment did not intervene
    expect((await res.json()).reached).toBe(true);
  });

  it('passes malformed and wrongly-signed tokens through rather than converting them to 403', async () => {
    const garbage = await request('/api/users', { rawToken: 'not-a-jwt' });
    const wrongSecret = await request('/api/users', {
      rawToken: jwt.sign({ userId: clientUser.id }, 'a-different-secret')
    });

    expect(garbage.status).toBe(200);
    expect(wrongSecret.status).toBe(200);
  });

  it('passes an expired CLIENT token through - authentication failure is not our 403', async () => {
    const expired = jwt.sign({ userId: clientUser.id }, process.env.JWT_SECRET, { expiresIn: -10 });
    const res = await request('/api/users', { rawToken: expired });
    expect(res.status).toBe(200);
  });

  it('passes a deactivated CLIENT through so requireAuth answers 401 Account deactivated', async () => {
    const res = await request('/api/users', { user: deactivatedClient });
    expect(res.status).toBe(200);
  });

  it('ignores non-API paths entirely', async () => {
    const res = await request('/staging', { user: clientUser });
    expect(res.status).toBe(200);
  });
});

describe('externalContainment - request cost', () => {
  it('resolves the user once and hands it to the downstream requireAuth', async () => {
    // First call populates the shared cache; the second must not re-query.
    await request('/api/client/me', { user: clientUser });
    const callsAfterFirst = prisma.user.findUnique.mock.calls.length;
    await request('/api/client/me', { user: clientUser });

    expect(callsAfterFirst).toBeLessThanOrEqual(1);
    expect(prisma.user.findUnique.mock.calls.length).toBe(callsAfterFirst);
  });
});
