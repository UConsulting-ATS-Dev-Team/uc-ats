// The welcome email, across all four ways an account can come into existence.
//
// The policy this pins down is *when* it sends, which is the part that is easy
// to get wrong: not at signup, where the address is still unproved and a second
// mail would land next to the verification link, but at the first moment
// somebody has demonstrated they can read the mailbox. For the two password
// paths that moment is verification; for Google it is account creation, because
// Google has already proved the address; for a member it is creation, because
// that path issues no verification link at all.
//
// The other half is that it sends *once* per account, and that a failure to
// send never takes the request down with it.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import prisma from '../prismaClient.js';
import authRoutes from './auth.js';
import config from '../config.js';
import { sendWelcomeEmail, sendEmailVerification } from '../services/emailNotifications.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    candidate: { create: vi.fn() }
  }
}));

vi.mock('../services/emailNotifications.js', () => ({
  sendPasswordResetEmail: vi.fn().mockResolvedValue({ success: true }),
  sendPasswordResetConfirmationEmail: vi.fn().mockResolvedValue({ success: true }),
  sendEmailVerification: vi.fn().mockResolvedValue({ success: true }),
  sendWelcomeEmail: vi.fn().mockResolvedValue({ success: true })
}));

vi.mock('../middleware/auth.js', () => ({ invalidateUserCache: vi.fn() }));

const verifyIdToken = vi.fn();
vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    verifyIdToken(...args) {
      return verifyIdToken(...args);
    }
  }
}));

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    default: {
      ...actual.default,
      googleClientId: 'test-client-id.apps.googleusercontent.com',
      memberRegistrationToken: 'member-token'
    }
  };
});

let server;
let port;

const post = (path, body) =>
  fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

/** A stored user as prisma would hand it back. */
const userRow = (overrides = {}) => ({
  id: 'user-1',
  email: 'joski@g.ucla.edu',
  password: '$2a$12$hashhashhashhashhashhash',
  fullName: 'Joski Bruin',
  role: 'USER',
  isActive: true,
  isExternalTalent: false,
  emailVerifiedAt: null,
  emailVerificationToken: 'a-live-token',
  emailVerificationExpiry: new Date(Date.now() + 60 * 60 * 1000),
  googleId: null,
  ...overrides
});

/** The single { audience, ctaUrl } the route asked for. */
const welcomeCall = () => {
  const [email, fullName, options] = sendWelcomeEmail.mock.calls[0];
  return { email, fullName, ...options };
};

// The three tests that post to a signup endpoint hash a password at bcrypt
// cost 12, which comfortably exceeds vitest's 5s default once the whole suite
// is running in parallel. Nothing about them is slow on purpose.
const SIGNUP_TIMEOUT_MS = 20_000;

// The row prisma is pretending to hold. Kept as a variable rather than set
// straight onto findUnique because an update has to return the *stored* row
// with the patch applied - a fixed default here would quietly drop fields the
// route reads back off the update, isExternalTalent among them.
let stored = null;
const givenStoredUser = (overrides = {}) => {
  stored = userRow(overrides);
  prisma.user.findUnique.mockResolvedValue(stored);
  return stored;
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
  sendWelcomeEmail.mockResolvedValue({ success: true });
  sendEmailVerification.mockResolvedValue({ success: true });
  stored = null;
  prisma.user.findUnique.mockResolvedValue(null);
  prisma.user.findFirst.mockResolvedValue(null);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.user.update.mockImplementation(({ where, data }) =>
    Promise.resolve({ ...(stored ?? userRow({ id: where.id })), ...data })
  );
  prisma.user.create.mockImplementation(({ data }) => Promise.resolve({ id: 'new-user-1', ...data }));
  prisma.candidate.create.mockResolvedValue({ id: 'candidate-1' });
});

describe('welcome email on verification', () => {
  it('welcomes a candidate when they verify, not when they sign up', async () => {
    const signup = await post('/api/auth/register', {
      email: 'Joski@ucla.edu',
      password: 'a-long-enough-password',
      fullName: 'Joski Bruin',
      graduationClass: '2027',
      studentId: '123456789'
    });
    expect(signup.status).toBe(201);
    expect(sendEmailVerification).toHaveBeenCalledTimes(1);
    expect(sendWelcomeEmail).not.toHaveBeenCalled();

    givenStoredUser();
    const verified = await post('/api/auth/verify-email', { token: 'a-live-token' });

    expect(verified.status).toBe(200);
    expect(sendWelcomeEmail).toHaveBeenCalledTimes(1);
    expect(welcomeCall()).toMatchObject({
      email: 'joski@g.ucla.edu',
      fullName: 'Joski Bruin',
      audience: 'candidate',
      ctaUrl: config.clientUrl
    });
  }, SIGNUP_TIMEOUT_MS);

  it('welcomes a talent-portal account with the talent copy, not the candidate copy', async () => {
    // Role USER covers both kinds of person, so branching on role alone would
    // send this student a mail about an application they never made.
    givenStoredUser({ isExternalTalent: true });

    await post('/api/auth/verify-email', { token: 'a-live-token' });

    expect(welcomeCall().audience).toBe('talent');
  });

  it('does not welcome again when an already-verified account re-verifies', async () => {
    givenStoredUser({ emailVerifiedAt: new Date('2026-01-01') });

    const res = await post('/api/auth/verify-email', { token: 'a-live-token' });

    expect(res.status).toBe(200);
    expect(sendWelcomeEmail).not.toHaveBeenCalled();
  });

  it('does not welcome on an expired token, because the address is still unproved', async () => {
    givenStoredUser({ emailVerificationExpiry: new Date(Date.now() - 1000) });

    const res = await post('/api/auth/verify-email', { token: 'a-live-token' });

    expect(res.status).toBe(400);
    expect(sendWelcomeEmail).not.toHaveBeenCalled();
  });

  it('still verifies the account when the welcome fails to send', async () => {
    givenStoredUser();
    sendWelcomeEmail.mockResolvedValue({ success: false, error: 'SES refused' });

    const res = await post('/api/auth/verify-email', { token: 'a-live-token' });

    expect(res.status).toBe(200);
    expect((await res.json()).user.emailVerifiedAt).toBeTruthy();
  });
});

describe('welcome email on the paths that skip verification', () => {
  it('welcomes a new Google account at creation', async () => {
    verifyIdToken.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-1',
        email: 'joski@g.ucla.edu',
        email_verified: true,
        name: 'Joski Bruin'
      })
    });

    const res = await post('/api/auth/google', { credential: 'fake-id-token' });

    expect(res.status).toBe(201);
    // createFromGoogle sets isExternalTalent - a Google signup has no
    // application, so it gets the portal's copy.
    expect(welcomeCall()).toMatchObject({ audience: 'talent', ctaUrl: config.clientUrl });
  });

  it('does not welcome a returning Google user', async () => {
    verifyIdToken.mockResolvedValue({
      getPayload: () => ({
        sub: 'google-sub-1',
        email: 'joski@g.ucla.edu',
        email_verified: true,
        name: 'Joski Bruin'
      })
    });
    givenStoredUser({ googleId: 'google-sub-1', emailVerifiedAt: new Date('2026-01-01') });

    const res = await post('/api/auth/google', { credential: 'fake-id-token' });

    expect(res.status).toBe(200);
    expect(sendWelcomeEmail).not.toHaveBeenCalled();
  });

  it('welcomes a new member at creation, with the member copy', async () => {
    const res = await post('/api/auth/register-member', {
      email: 'member@ucla.edu',
      password: 'a-long-enough-password',
      fullName: 'Pam Beesly',
      graduationClass: '2027',
      studentId: '987654321',
      accessToken: 'member-token'
    });

    expect(res.status).toBe(201);
    // No verification link is issued on this path, so creation is the only
    // moment there is to send it.
    expect(sendEmailVerification).not.toHaveBeenCalled();
    expect(welcomeCall()).toMatchObject({
      email: 'member@ucla.edu',
      fullName: 'Pam Beesly',
      audience: 'member'
    });
  }, SIGNUP_TIMEOUT_MS);

  it('does not welcome when the member registration token is wrong', async () => {
    const res = await post('/api/auth/register-member', {
      email: 'member@ucla.edu',
      password: 'a-long-enough-password',
      fullName: 'Pam Beesly',
      graduationClass: '2027',
      studentId: '987654321',
      accessToken: 'not-the-token'
    });

    expect(res.status).toBe(403);
    expect(sendWelcomeEmail).not.toHaveBeenCalled();
  });

  it('does not welcome an external signup until it verifies', async () => {
    const res = await post('/api/auth/register-external', {
      fullName: 'Joski Bruin',
      email: 'joski@g.ucla.edu',
      password: 'a-long-enough-password',
      graduationYear: '2027'
    });

    expect(res.status).toBe(201);
    expect(sendEmailVerification).toHaveBeenCalledTimes(1);
    expect(sendWelcomeEmail).not.toHaveBeenCalled();
  }, SIGNUP_TIMEOUT_MS);
});
