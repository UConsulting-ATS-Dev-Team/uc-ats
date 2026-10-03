// requireAuth's answers when it cannot produce a user.
//
// The client signs a person out on 401 + SESSION_INVALID and on nothing else,
// so what is pinned here is which failures carry that code and which must not:
// a request with no token has no session to end, and a database failure is a
// 503, never a 401, or one Supabase blip would sign out everyone at once.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import { requireAuth, invalidateUserCache } from './auth.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn() }
  }
}));

const activeUser = { id: 'user-1', role: 'MEMBER', isActive: true, email: 'm@ucla.edu', fullName: 'Member' };
const deactivatedUser = { id: 'user-2', role: 'MEMBER', isActive: false, email: 'x@ucla.edu', fullName: 'Former' };

const tokenFor = (userId, options) => jwt.sign({ userId }, process.env.JWT_SECRET, options);

const run = async (authorization) => {
  const req = { headers: authorization ? { authorization } : {} };
  const res = {
    status: vi.fn(function status(code) { this.statusCode = code; return this; }),
    json: vi.fn(function json(body) { this.body = body; return this; })
  };
  const next = vi.fn();
  await requireAuth(req, res, next);
  return { req, res, next };
};

let consoleError;

beforeEach(() => {
  vi.clearAllMocks();
  invalidateUserCache([activeUser.id, deactivatedUser.id, 'gone']);
  prisma.user.findUnique.mockImplementation(({ where: { id } }) =>
    [activeUser, deactivatedUser].find((u) => u.id === id) || null
  );
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('requireAuth', () => {
  it('attaches the user and calls next for a valid token', async () => {
    const { req, res, next } = await run(`Bearer ${tokenFor(activeUser.id)}`);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.user).toEqual(activeUser);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('answers an expired token with SESSION_INVALID and logs nothing', async () => {
    const { res, next } = await run(`Bearer ${tokenFor(activeUser.id, { expiresIn: -10 })}`);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid token', code: 'SESSION_INVALID', reason: 'expired' });
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('answers a malformed token with SESSION_INVALID and still logs it', async () => {
    const { res } = await run('Bearer not-a-jwt');
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid token', code: 'SESSION_INVALID', reason: 'invalid' });
    expect(consoleError).toHaveBeenCalledWith('Auth middleware error:', expect.any(Error));
  });

  it('answers a deleted user with SESSION_INVALID', async () => {
    const { res } = await run(`Bearer ${tokenFor('gone')}`);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'User not found', code: 'SESSION_INVALID', reason: 'not-found' });
  });

  it('answers a deactivated user with SESSION_INVALID', async () => {
    const { res } = await run(`Bearer ${tokenFor(deactivatedUser.id)}`);
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Account deactivated', code: 'SESSION_INVALID', reason: 'deactivated' });
  });

  it('answers a request with no token with a plain 401 and no code', async () => {
    const { res } = await run();
    expect(res.statusCode).toBe(401);
    expect(res.body).toEqual({ error: 'Authentication required' });
  });

  it('answers a failed user lookup with 503 AUTH_UNAVAILABLE, not a 401', async () => {
    const dbError = new Error("Can't reach database server");
    prisma.user.findUnique.mockRejectedValue(dbError);

    const { res, next } = await run(`Bearer ${tokenFor(activeUser.id)}`);

    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(503);
    expect(res.body).toEqual({
      error: 'Authentication is temporarily unavailable',
      code: 'AUTH_UNAVAILABLE'
    });
    expect(consoleError).toHaveBeenCalledWith('Auth middleware lookup failed:', dbError);
  });
});
