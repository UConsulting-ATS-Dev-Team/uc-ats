// Sign in with Google.
//
// The cases that matter are the ones where getting it wrong hands somebody a
// session they should not have: an unverified Google email must not be honoured,
// a mixed-case stored address must still be recognised as the same person (or a
// second account gets created for them), and a linked account must resolve to
// itself even after the address at Google changes.
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import authRoutes from './auth.js';
import { invalidateUserCache } from '../middleware/auth.js';

vi.mock('../prismaClient.js', () => ({
  default: {
    user: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    candidate: { create: vi.fn() }
  }
}));

vi.mock('../services/emailNotifications.js', () => ({
  sendPasswordResetEmail: vi.fn().mockResolvedValue({ success: true }),
  sendPasswordResetConfirmationEmail: vi.fn().mockResolvedValue({ success: true }),
  sendEmailVerification: vi.fn().mockResolvedValue({ success: true })
}));

// auth.js imports only invalidateUserCache from this module, so replacing it
// wholesale is safe and lets the cache call be asserted - it is the subtle one,
// because forgetting it leaves a just-verified account looking unverified for
// another five minutes.
vi.mock('../middleware/auth.js', () => ({ invalidateUserCache: vi.fn() }));

const verifyIdToken = vi.fn();
vi.mock('google-auth-library', () => ({
  OAuth2Client: class {
    verifyIdToken(...args) {
      return verifyIdToken(...args);
    }
  }
}));

// The route refuses outright when no client id is configured, so every test
// that expects to get past that needs one.
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal();
  return { default: { ...actual.default, googleClientId: 'test-client-id.apps.googleusercontent.com' } };
});

let server;
let port;

const post = (path, body) =>
  fetch(`http://localhost:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

const signIn = (credential = 'fake-id-token') => post('/api/auth/google', { credential });

/** A Google ID token payload, as verifyIdToken would hand it back. */
const payload = (overrides = {}) => ({
  sub: 'google-sub-1',
  email: 'joski@g.ucla.edu',
  email_verified: true,
  name: 'Joski Bruin',
  picture: 'https://lh3.googleusercontent.com/a/joski',
  ...overrides
});

const givenGoogleReturns = (value) => {
  verifyIdToken.mockResolvedValue({ getPayload: () => value });
};

const existingUser = (overrides = {}) => ({
  id: 'user-1',
  email: 'joski@g.ucla.edu',
  password: '$2a$12$hashhashhashhashhashhash',
  fullName: 'Joski Bruin',
  role: 'USER',
  isActive: true,
  isExternalTalent: false,
  emailVerifiedAt: new Date('2026-01-01'),
  emailVerificationToken: null,
  emailVerificationExpiry: null,
  googleId: null,
  profileImage: null,
  ...overrides
});

/** Whatever the route passed to prisma.user.create, as the row would come back. */
const createdRow = () => {
  const { data } = prisma.user.create.mock.calls[0][0];
  return { id: 'new-user-1', ...data };
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
  givenGoogleReturns(payload());
  prisma.user.findUnique.mockResolvedValue(null);
  prisma.user.findMany.mockResolvedValue([]);
  prisma.user.update.mockImplementation(({ where, data }) =>
    Promise.resolve({ ...existingUser({ id: where.id }), ...data })
  );
  prisma.user.create.mockImplementation(() => Promise.resolve(createdRow()));
});

describe('POST /api/auth/google', () => {
  it('refuses a token Google will not vouch for, and touches nothing', async () => {
    verifyIdToken.mockRejectedValue(new Error('Invalid token signature'));

    const res = await signIn();

    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('GOOGLE_BAD_CREDENTIAL');
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('verifies the token against our own client id, not just any Google signature', async () => {
    await signIn();

    expect(verifyIdToken).toHaveBeenCalledWith({
      idToken: 'fake-id-token',
      audience: 'test-client-id.apps.googleusercontent.com'
    });
  });

  it('refuses an unverified Google email without creating an account', async () => {
    givenGoogleReturns(payload({ email_verified: false }));

    const res = await signIn();

    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('GOOGLE_EMAIL_UNVERIFIED');
    // The takeover assertion: an unverified address must never become an
    // account, nor be matched against one.
    expect(prisma.user.create).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('links an existing account whose email matches', async () => {
    prisma.user.findMany.mockResolvedValue([existingUser()]);

    const res = await signIn();
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(prisma.user.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'user-1' },
        data: expect.objectContaining({ googleId: 'google-sub-1' })
      })
    );
    expect(body.isNewAccount).toBe(false);
    expect(jwt.verify(body.token, process.env.JWT_SECRET).userId).toBe('user-1');
  });

  it('links an account stored with different casing rather than creating a second one', async () => {
    // The pre-migration shape: /register kept whatever case was typed.
    prisma.user.findMany.mockResolvedValue([existingUser({ email: 'Joski@G.UCLA.edu' })]);

    const res = await signIn();

    expect(res.status).toBe(200);
    expect(prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { email: { equals: 'joski@g.ucla.edu', mode: 'insensitive' } }
      })
    );
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('refuses rather than guessing when two accounts share an address', async () => {
    prisma.user.findMany.mockResolvedValue([
      existingUser({ id: 'user-1', email: 'Joski@G.UCLA.edu' }),
      existingUser({ id: 'user-2', email: 'JOSKI@g.ucla.edu' })
    ]);

    const res = await signIn();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe('GOOGLE_AMBIGUOUS_EMAIL');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('proves the address when linking an unverified account, and drops the stale token', async () => {
    prisma.user.findMany.mockResolvedValue([
      existingUser({
        emailVerifiedAt: null,
        emailVerificationToken: 'a-live-token',
        emailVerificationExpiry: new Date(Date.now() + 1000)
      })
    ]);

    await signIn();

    const { data } = prisma.user.update.mock.calls[0][0];
    expect(data.emailVerifiedAt).toBeInstanceOf(Date);
    // A verification token outliving the thing it verifies is a takeover primitive.
    expect(data.emailVerificationToken).toBeNull();
    expect(data.emailVerificationExpiry).toBeNull();
    // Without this the talent portal keeps refusing uploads for another five minutes.
    expect(invalidateUserCache).toHaveBeenCalledWith('user-1');
  });

  it('finds a linked account by googleId even after the address at Google changes', async () => {
    prisma.user.findUnique.mockResolvedValue(existingUser({ googleId: 'google-sub-1' }));
    givenGoogleReturns(payload({ email: 'joski.bruin@gmail.com' }));

    const res = await signIn();

    expect(res.status).toBe(200);
    expect(prisma.user.findUnique).toHaveBeenCalledWith({ where: { googleId: 'google-sub-1' } });
    // The email branch is never consulted, so no second account is made for the
    // new address and users.email is left alone.
    expect(prisma.user.findMany).not.toHaveBeenCalled();
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('creates a pre-verified talent account when nobody matches', async () => {
    const res = await signIn();
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.isNewAccount).toBe(true);

    const { data } = prisma.user.create.mock.calls[0][0];
    expect(data).toMatchObject({
      email: 'joski@g.ucla.edu',
      password: null,
      fullName: 'Joski Bruin',
      role: 'USER',
      isExternalTalent: true,
      googleId: 'google-sub-1'
    });
    expect(data.emailVerifiedAt).toBeInstanceOf(Date);
    // Google cannot tell us these, and an empty studentId would collide on the
    // unique index with every other such account.
    expect(data.graduationClass).toBeUndefined();
    expect(data.studentId).toBeUndefined();
    // Somebody who clicked a Google button has not applied to anything.
    expect(prisma.candidate.create).not.toHaveBeenCalled();
  });

  it('does not take a profile picture from Google', async () => {
    await signIn();

    // profileImage is what GTKUC completeness reads; filling it would mark a
    // profile complete with a photo the member never chose.
    expect(prisma.user.create.mock.calls[0][0].data.profileImage).toBeUndefined();
  });

  it('falls back to the local part when Google sends no name', async () => {
    givenGoogleReturns(payload({ name: undefined }));

    await signIn();

    expect(prisma.user.create.mock.calls[0][0].data.fullName).toBe('joski');
  });

  it('refuses a deactivated account without linking to it', async () => {
    prisma.user.findMany.mockResolvedValue([existingUser({ isActive: false })]);

    const res = await signIn();

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Account deactivated');
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('never returns the password or the Google id', async () => {
    prisma.user.findMany.mockResolvedValue([existingUser()]);

    const body = await (await signIn()).json();

    expect(body.user.password).toBeUndefined();
    expect(body.user.googleId).toBeUndefined();
    expect(body.user.hasPassword).toBe(true);
    expect(body.user.hasGoogle).toBe(true);
  });

  it('settles a race between two first-time sign-ins instead of failing one', async () => {
    const conflict = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    prisma.user.create.mockRejectedValue(conflict);
    // The winner's row, readable by the time the loser retries.
    prisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingUser({ googleId: 'google-sub-1' }));

    const res = await signIn();

    expect(res.status).toBe(200);
    expect((await res.json()).isNewAccount).toBe(false);
  });
});

// What a nullable password changed elsewhere. Both of these are silent
// regressions rather than missing features, which is why they are pinned here
// next to the thing that caused them.
describe('accounts with no password', () => {
  it('tells a Google-only account which button works, instead of erroring', async () => {
    prisma.user.findFirst.mockResolvedValue(existingUser({ password: null }));

    const res = await post('/api/auth/login', {
      email: 'joski@g.ucla.edu',
      password: 'anything'
    });

    // bcrypt.compare(password, null) throws, which the route's catch would
    // otherwise turn into a 500 on an ordinary sign-in attempt.
    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('GOOGLE_ACCOUNT');
  });

  it('still refuses an unknown address in the same words as a wrong password', async () => {
    prisma.user.findFirst.mockResolvedValue(null);

    const res = await post('/api/auth/login', { email: 'nobody@ucla.edu', password: 'x' });

    expect(res.status).toBe(401);
    expect((await res.json()).error).toBe('Invalid email or password');
  });

  it('tells somebody signing up with a taken student ID what to do about it', async () => {
    // The shape Google sign-in produces: an account exists under another
    // address, so the email is free but the student ID is not.
    prisma.user.findFirst
      .mockResolvedValueOnce(null)                                  // email is free
      .mockResolvedValueOnce(existingUser({ studentId: '123456789' })); // ID is not

    const res = await post('/api/auth/register', {
      email: 'joski.bruin@gmail.com',
      password: 'a-long-enough-password',
      fullName: 'Joski Bruin',
      graduationClass: '2027',
      studentId: '123456789'
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.code).toBe('STUDENT_ID_TAKEN');
    expect(body.error).toMatch(/different email/i);
    // Actionable, not just a refusal.
    expect(body.error).toMatch(/forgot password/i);
    // Never names the address holding it - that would turn a student ID into a
    // way to look somebody's email up.
    expect(body.error).not.toMatch(/joski@g\.ucla\.edu/);
    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it('does not let a fresh talent signup take over a Google account', async () => {
    // The takeover branch exists for abandoned, unverified signups. A Google
    // account is verified by definition, and also now carries googleId - if it
    // were ever taken over, both credentials would still work on it.
    prisma.user.findUnique.mockResolvedValue(
      existingUser({
        password: null,
        isExternalTalent: true,
        emailVerifiedAt: new Date(),
        googleId: 'google-sub-1'
      })
    );

    const res = await post('/api/auth/register-external', {
      fullName: 'Someone Else',
      email: 'Joski@G.UCLA.edu',
      password: 'a-long-enough-password',
      graduationYear: '2027'
    });

    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/already exists/i);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/google (races)', () => {
  it('settles a race between two first-time sign-ins instead of failing one', async () => {
    const conflict = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    prisma.user.create.mockRejectedValue(conflict);
    // The winner's row, readable by the time the loser retries.
    prisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(existingUser({ googleId: 'google-sub-1' }));

    const res = await signIn();

    expect(res.status).toBe(200);
    expect((await res.json()).isNewAccount).toBe(false);
  });
});
