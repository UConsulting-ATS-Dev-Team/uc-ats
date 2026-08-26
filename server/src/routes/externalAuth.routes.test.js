// Public signup and email verification for the external talent portal.
//
// Three things are worth pinning down: a non-UCLA address cannot register, a
// verification token never rides back in a response body, and an unverified
// account can be taken over by a fresh signup (which is what stops a squatter
// from locking a student out of their own address forever).
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import authRoutes from './auth.js';
import { sendEmailVerification } from '../services/emailNotifications.js';
import { VERIFICATION_TTL_MS } from '../utils/externalTalent.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    candidate: { create: vi.fn() }
  }
}));

vi.mock('../services/emailNotifications.js', () => ({
  sendPasswordResetEmail: vi.fn().mockResolvedValue({ success: true }),
  sendPasswordResetConfirmationEmail: vi.fn().mockResolvedValue({ success: true }),
  sendEmailVerification: vi.fn().mockResolvedValue({ success: true })
}));

let server;
let port;

const post = (path, body) =>
  fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

const signupBody = {
  fullName: 'Joski Bruin',
  email: 'Joski@G.UCLA.edu',
  password: 'a-long-enough-password',
  graduationYear: '2027'
};

// Whatever the route passed to prisma.user.create, as the created row would
// look coming back out.
const createdRow = () => {
  const { data } = prisma.user.create.mock.calls[0][0];
  return { id: 'talent-1', ...data };
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  server = app.listen(0);
  await new Promise((resolve) => server.on('listening', resolve));
  port = server.address().port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  vi.clearAllMocks();
  prisma.user.findUnique.mockResolvedValue(null);
  prisma.user.create.mockImplementation(({ data }) => ({ id: 'talent-1', ...data }));
  prisma.user.update.mockImplementation(({ data }) => ({ id: 'talent-1', ...signupBody, ...data }));
});

describe('POST /register-external', () => {
  it('creates a verified-pending USER flagged as external talent', async () => {
    const res = await post('/api/auth/register-external', signupBody);
    expect(res.status).toBe(201);

    const { data } = prisma.user.create.mock.calls[0][0];
    expect(data.role).toBe('USER');
    expect(data.isExternalTalent).toBe(true);
    expect(data.emailVerifiedAt).toBeUndefined();
    // Four bare digits, so it filters alike with Application.graduationYear.
    expect(data.graduationClass).toBe('2027');
  });

  it('never creates a Candidate row - these people have not applied to anything', async () => {
    await post('/api/auth/register-external', signupBody);
    expect(prisma.candidate.create).not.toHaveBeenCalled();
  });

  it('lowercases the address so one mailbox cannot become two accounts', async () => {
    await post('/api/auth/register-external', signupBody);
    expect(prisma.user.create.mock.calls[0][0].data.email).toBe('joski@g.ucla.edu');
  });

  it('refuses a non-UCLA address', async () => {
    const res = await post('/api/auth/register-external', { ...signupBody, email: 'joski@gmail.com' });
    expect(res.status).toBe(400);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('refuses a lookalike domain', async () => {
    for (const email of ['joski@notucla.edu', 'joski@ucla.edu.attacker.com']) {
      const res = await post('/api/auth/register-external', { ...signupBody, email });
      expect({ email, status: res.status }).toEqual({ email, status: 400 });
    }
  });

  it('sends the verification link and stores its token hashed into no response', async () => {
    const res = await post('/api/auth/register-external', signupBody);
    const body = await res.json();

    expect(sendEmailVerification).toHaveBeenCalledTimes(1);
    const [, , link] = sendEmailVerification.mock.calls[0];
    const token = new URL(link, 'http://localhost').searchParams.get('token');
    expect(token).toBeTruthy();

    // The whole point of verification: a caller who could read their own token
    // out of this response would never need to open the mailbox.
    expect(JSON.stringify(body)).not.toContain(token);
    expect(body.user).not.toHaveProperty('emailVerificationToken');
    expect(body.user).not.toHaveProperty('password');
  });

  it('issues a session anyway, so the portal can show a real "check your inbox" state', async () => {
    const res = await post('/api/auth/register-external', signupBody);
    const body = await res.json();
    expect(jwt.verify(body.token, process.env.JWT_SECRET).userId).toBe('talent-1');
  });

  it('takes over an existing account that was never verified', async () => {
    // Nobody has proved they read that mailbox, so there is nothing to protect -
    // and without this a squatter (or one abandoned typo) locks the real owner
    // out of their own address permanently.
    prisma.user.findUnique.mockResolvedValue({
      id: 'talent-1',
      email: 'joski@g.ucla.edu',
      role: 'USER',
      isExternalTalent: true,
      emailVerifiedAt: null
    });

    const res = await post('/api/auth/register-external', signupBody);
    expect(res.status).toBe(201);
    expect(prisma.user.update).toHaveBeenCalled();
    expect(sendEmailVerification).toHaveBeenCalledTimes(1);
  });

  it('refuses to take over an account that IS verified', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'talent-1',
      email: 'joski@g.ucla.edu',
      role: 'USER',
      isExternalTalent: true,
      emailVerifiedAt: new Date('2026-08-20')
    });

    const res = await post('/api/auth/register-external', signupBody);
    expect(res.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('refuses to take over a staff account that happens to share the address', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'admin-1',
      email: 'joski@g.ucla.edu',
      role: 'ADMIN',
      isExternalTalent: false,
      emailVerifiedAt: null
    });

    const res = await post('/api/auth/register-external', signupBody);
    expect(res.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe('POST /verify-email', () => {
  const pending = (expiryOffsetMs = VERIFICATION_TTL_MS) => ({
    id: 'talent-1',
    email: 'joski@g.ucla.edu',
    role: 'USER',
    isExternalTalent: true,
    emailVerifiedAt: null,
    emailVerificationToken: 'a-token',
    emailVerificationExpiry: new Date(Date.now() + expiryOffsetMs)
  });

  it('verifies and burns the token in one write', async () => {
    prisma.user.findUnique.mockResolvedValue(pending());
    prisma.user.update.mockImplementation(({ data }) => ({ ...pending(), ...data }));

    const res = await post('/api/auth/verify-email', { token: 'a-token' });
    expect(res.status).toBe(200);

    const { data } = prisma.user.update.mock.calls[0][0];
    expect(data.emailVerifiedAt).toBeInstanceOf(Date);
    // Single-use: a second click gets "invalid or already used".
    expect(data.emailVerificationToken).toBeNull();
    expect(data.emailVerificationExpiry).toBeNull();
  });

  it('rejects an expired link without verifying', async () => {
    prisma.user.findUnique.mockResolvedValue(pending(-1000));
    const res = await post('/api/auth/verify-email', { token: 'a-token' });
    expect(res.status).toBe(400);
    expect((await res.json()).expired).toBe(true);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('rejects an unknown token', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const res = await post('/api/auth/verify-email', { token: 'nope' });
    expect(res.status).toBe(400);
  });

  it('rejects a missing token', async () => {
    const res = await post('/api/auth/verify-email', {});
    expect(res.status).toBe(400);
  });
});

describe('POST /resend-verification', () => {
  const generic = 'If that account needs verification, a new link is on its way.';

  it('answers identically for an unknown address', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    const res = await post('/api/auth/resend-verification', { email: 'nobody@g.ucla.edu' });
    expect(res.status).toBe(200);
    expect((await res.json()).message).toBe(generic);
    expect(sendEmailVerification).not.toHaveBeenCalled();
  });

  it('answers identically for an already-verified account', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'talent-1',
      email: 'joski@g.ucla.edu',
      isExternalTalent: true,
      emailVerifiedAt: new Date()
    });
    const res = await post('/api/auth/resend-verification', { email: 'joski@g.ucla.edu' });
    expect((await res.json()).message).toBe(generic);
    expect(sendEmailVerification).not.toHaveBeenCalled();
  });

  it('sends a fresh link for a pending account whose cooldown has passed', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'talent-1',
      email: 'joski@g.ucla.edu',
      fullName: 'Joski Bruin',
      isExternalTalent: true,
      emailVerifiedAt: null,
      // Issued a full TTL ago, so the cooldown is long past.
      emailVerificationExpiry: new Date(Date.now())
    });
    await post('/api/auth/resend-verification', { email: 'joski@g.ucla.edu' });
    expect(sendEmailVerification).toHaveBeenCalledTimes(1);
  });

  it('silently declines inside the cooldown rather than becoming a signup probe', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'talent-1',
      email: 'joski@g.ucla.edu',
      isExternalTalent: true,
      emailVerifiedAt: null,
      // Just issued.
      emailVerificationExpiry: new Date(Date.now() + VERIFICATION_TTL_MS)
    });
    const res = await post('/api/auth/resend-verification', { email: 'joski@g.ucla.edu' });
    expect((await res.json()).message).toBe(generic);
    expect(sendEmailVerification).not.toHaveBeenCalled();
  });
});
