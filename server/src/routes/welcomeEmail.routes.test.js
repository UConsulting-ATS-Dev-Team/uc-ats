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
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn()
    },
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

// The row prisma is pretending to hold, as one mutable variable rather than a
// canned return per call. Verification now writes with updateMany and reads the
// row back, so a mock that answered every read with the same frozen row would
// hide whether the write happened at all - and, worse, would report count 1 to
// a second request whose token had already been burned.
let stored = null;
const givenStoredUser = (overrides = {}) => {
  stored = userRow(overrides);
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
  prisma.user.findUnique.mockImplementation(() => Promise.resolve(stored));
  prisma.user.findFirst.mockResolvedValue(null);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.user.update.mockImplementation(({ where, data }) => {
    stored = { ...(stored ?? userRow({ id: where.id })), ...data };
    return Promise.resolve(stored);
  });
  // The real thing matches on the token as well as the id, so a request whose
  // token has already been burned by a concurrent one writes nothing and gets
  // count 0. That is the whole guard against a duplicate welcome.
  prisma.user.updateMany.mockImplementation(({ where, data }) => {
    if (!stored || stored.emailVerificationToken !== where.emailVerificationToken) {
      return Promise.resolve({ count: 0 });
    }
    stored = { ...stored, ...data };
    return Promise.resolve({ count: 1 });
  });
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

  it('welcomes once when two requests verify the same token at the same time', async () => {
    // The race is both requests reading before either writes, so the by-token
    // lookup hands back the pre-race row to each of them and the pre-update
    // emailVerifiedAt check passes twice. Only the one whose updateMany
    // actually matched the token may send. Letting the lookup see the live row
    // instead would just serialise the two and prove nothing.
    const snapshot = { ...givenStoredUser() };
    prisma.user.findUnique.mockImplementation(({ where }) =>
      Promise.resolve(where?.emailVerificationToken ? { ...snapshot } : stored)
    );

    const [first, second] = await Promise.all([
      post('/api/auth/verify-email', { token: 'a-live-token' }),
      post('/api/auth/verify-email', { token: 'a-live-token' })
    ]);

    expect([first.status, second.status]).toEqual([200, 200]);
    expect(prisma.user.updateMany).toHaveBeenCalledTimes(2);
    expect(sendWelcomeEmail).toHaveBeenCalledTimes(1);
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
