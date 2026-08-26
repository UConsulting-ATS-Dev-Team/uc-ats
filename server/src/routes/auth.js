import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import config from '../config.js';
import crypto from 'crypto';
import { invalidateUserCache } from '../middleware/auth.js';
import {
  sendPasswordResetEmail,
  sendPasswordResetConfirmationEmail,
  sendEmailVerification
} from '../services/emailNotifications.js';
import {
  sanitizeExternalSignup,
  createVerificationToken,
  VERIFICATION_TTL_MS,
  normalizeEmail
} from '../utils/externalTalent.js';

const router = express.Router();

/**
 * The user shape every endpoint in this file returns.
 *
 * One helper rather than the four inline destructurings this file used to
 * repeat, because the list of secrets on User is no longer memorable and a
 * fifth endpoint that forgets one is the likely failure. emailVerificationToken
 * is the field that made this worth centralizing: a caller who can read their
 * own verification token out of a login response can verify their address
 * without ever opening the mailbox, which is the entire thing verification is
 * for.
 */
const publicUser = (user) => {
  const {
    password: _password,
    resetToken: _resetToken,
    resetTokenExpiry: _resetTokenExpiry,
    emailVerificationToken: _emailVerificationToken,
    emailVerificationExpiry: _emailVerificationExpiry,
    ...safe
  } = user;
  return safe;
};

const signToken = (user) =>
  jwt.sign(
    { userId: user.id, email: user.email, role: user.role },
    config.jwtSecret,
    { expiresIn: config.jwtExpiresIn },
  );

// Register new user
router.post('/register', async (req, res) => {
  try {
    const { email, password, fullName, graduationClass, studentId } = req.body;
    
    // Validate required fields
    if (!email || !password || !fullName || !graduationClass || !studentId) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    
    // Validate student ID is exactly 9 digits
    if (!/^\d{9}$/.test(studentId.toString())) {
      return res.status(400).json({ error: 'Student ID must be exactly 9 digits' });
    }
    
    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });
    
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists with this email. Sign in instead.' });
    }
    
    // Check if student ID is already taken
    const existingStudentId = await prisma.user.findFirst({
      where: { studentId: studentId }
    });
    
    if (existingStudentId) {
      return res.status(400).json({ error: 'Student ID is already registered' });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);
    
    // Create user
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        fullName,
        graduationClass,
        studentId: studentId,
      }
    });
    
    // If user role is USER, automatically create a candidate record
    if (user.role === 'USER') {
      try {
        // Split full name into first and last name
        const nameParts = fullName.trim().split(' ');
        const firstName = nameParts[0] || '';
        const lastName = nameParts.slice(1).join(' ') || '';
        
        await prisma.candidate.create({
          data: {
            studentId: studentId,
            firstName,
            lastName,
            email,
          }
        });
        console.log(`Created candidate record for user: ${email}`);
      } catch (candidateError) {
        console.error('Error creating candidate record:', candidateError);
        // Don't fail the registration if candidate creation fails
        // The user can still be created and function normally
      }
    }
    
    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn },
    );

    // Return user info and token. resetToken/resetTokenExpiry are stripped
    // alongside the password - this payload now goes to Talent Partner Network
    // clients too, and a live reset token is an account takeover primitive.
    const userWithoutPassword = publicUser(user);
    res.status(201).json({
      message: 'User created successfully',
      user: userWithoutPassword,
      token
    });

  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Login user
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }
    
    // Find user
    const user = await prisma.user.findUnique({
      where: { email }
    });
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }
    
    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password);
    
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (user.isActive === false) {
      return res.status(401).json({ error: 'Account deactivated' });
    }
    
    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn },
    );

    // Return user info and token. resetToken/resetTokenExpiry are stripped
    // alongside the password - this payload now goes to Talent Partner Network
    // clients too, and a live reset token is an account takeover primitive.
    const userWithoutPassword = publicUser(user);
    res.json({
      message: 'Login successful',
      user: userWithoutPassword,
      token
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Verify token (for checking if user is still authenticated)
router.get('/verify', async (req, res) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'No token provided' });
    }
    
    const decoded = jwt.verify(token, config.jwtSecret);
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId }
    });
    
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    if (user.isActive === false) {
      return res.status(401).json({ error: 'Account deactivated' });
    }
    
    const userWithoutPassword = publicUser(user);
    res.json({ user: userWithoutPassword });
    
  } catch (error) {
    console.error('Token verification error:', error);
    res.status(401).json({ error: 'Invalid token' });
  }
});

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  try {
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user) {
      // Don't reveal if email exists
      return res.json({ message: 'If that email exists, a reset link has been sent.' });
    }

    // Talent Partner Network clients have no self-service password reset - an
    // admin sets their password. This endpoint is unauthenticated, so the
    // containment middleware cannot see the role; the check has to live here.
    // Same generic response as an unknown email, and no token is minted.
    if (user.role === 'CLIENT') {
      return res.json({ message: 'If that email exists, a reset link has been sent.' });
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const resetTokenExpiry = new Date(Date.now() + 1000 * 60 * 30); // 30 mins

    await prisma.user.update({
      where: { email },
      data: {
        resetToken,
        resetTokenExpiry
      }
    });

    const resetLink = `${config.clientUrl}/reset-password?token=${resetToken}`;
    await sendPasswordResetEmail(email, resetLink);

    res.json({ message: 'Reset link sent if email exists' });

  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

router.post('/reset-password', async (req, res) => {
  const { token, newPassword } = req.body;

  try {
    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Missing token or new password' });
    }

    const user = await prisma.user.findFirst({
      where: {
        resetToken: token,
        resetTokenExpiry: {
          gte: new Date(), // ensure not expired
        },
      },
    });

    if (!user) {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    // Belt and braces for the forgot-password guard above: a CLIENT should
    // never hold a reset token, and if one exists it is not honoured.
    if (user.role === 'CLIENT') {
      return res.status(400).json({ error: 'Invalid or expired token' });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 12);

    await prisma.user.update({
      where: { id: user.id },
      data: {
        password: hashedPassword,
        resetToken: null,
        resetTokenExpiry: null,
      },
    });

    // Send confirmation email to the account email only; never expose the token or new password.
    if (user.email) {
      try {
        const confirmationResult = await sendPasswordResetConfirmationEmail(user.email, user.fullName);
        if (!confirmationResult.success) {
          console.error('Failed to send password reset confirmation email:', confirmationResult.error);
        }
      } catch (confirmationError) {
        console.error('Error sending password reset confirmation email:', confirmationError);
      }
    }

    res.json({ message: 'Password reset successful' });
  } catch (error) {
    console.error('Reset password error:', error); // this is what you check in terminal
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// Register new member (special endpoint)
router.post('/register-member', async (req, res) => {
  try {
    const { email, password, fullName, graduationClass, studentId, accessToken } = req.body;

    if (!accessToken || accessToken !== config.memberRegistrationToken) {
      return res.status(403).json({ error: 'Unauthorized access' });
    }
    
    // Validate required fields
    if (!email || !password || !fullName || !graduationClass || !studentId) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    
    // Validate student ID is exactly 9 digits
    if (!/^\d{9}$/.test(studentId.toString())) {
      return res.status(400).json({ error: 'Student ID must be exactly 9 digits' });
    }
    
    // Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });
    
    if (existingUser) {
      return res.status(400).json({ error: 'User already exists with this email. Sign in instead.' });
    }
    
    // Check if student ID is already taken
    const existingStudentId = await prisma.user.findFirst({
      where: { studentId: studentId }
    });
    
    if (existingStudentId) {
      return res.status(400).json({ error: 'Student ID is already registered' });
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);
    
    // Create user with MEMBER role
    const user = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        fullName,
        graduationClass,
        studentId: studentId,
        role: 'MEMBER', // Automatically set as MEMBER
      }
    });
    
    // Generate JWT token
    const token = jwt.sign(
      { userId: user.id, email: user.email, role: user.role },
      config.jwtSecret,
      { expiresIn: config.jwtExpiresIn },
    );

    // Return user info and token. resetToken/resetTokenExpiry are stripped
    // alongside the password - this payload now goes to Talent Partner Network
    // clients too, and a live reset token is an account takeover primitive.
    const userWithoutPassword = publicUser(user);
    res.status(201).json({
      message: 'Member created successfully',
      user: userWithoutPassword,
      token
    });
    
  } catch (error) {
    console.error('Member registration error:', error);
    res.status(500).json({ error: 'Failed to create member' });
  }
});

// ---------------------------------------------------------------------------
// External talent portal: public self-signup for UCLA students
// ---------------------------------------------------------------------------
//
// Separate from POST /register rather than a flag on it. That endpoint creates a
// Candidate row, because the people who reach it are applicants tracking an
// application; these people have not applied to anything, and a Candidate row
// for each of them would put strangers in the recruiting pipeline. Two
// endpoints, two meanings, and neither has to branch on the other's case.

const verificationLink = (token) => `${config.clientUrl}/talent/verify?token=${token}`;

// A resend is a mail send triggered by an unauthenticated caller, so it needs a
// floor. Derived from the stored expiry rather than a separate issuedAt column:
// expiry minus the TTL is when the current token was minted.
const RESEND_MIN_INTERVAL_MS = 60 * 1000;

const tokenIssuedAt = (user) =>
  user.emailVerificationExpiry
    ? new Date(user.emailVerificationExpiry.getTime() - VERIFICATION_TTL_MS)
    : null;

router.post('/register-external', async (req, res) => {
  try {
    const { value, errors } = sanitizeExternalSignup(req.body || {});
    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], errors });
    }

    const existing = await prisma.user.findUnique({ where: { email: value.email } });

    // An existing but never-verified account is not evidence of anything: nobody
    // has proved they read that mailbox, so there is nothing to protect and the
    // signup simply takes it over. This is what keeps one abandoned typo - or
    // someone squatting a classmate's address - from locking the real owner out
    // of their own email forever.
    if (existing && existing.role === 'USER' && existing.isExternalTalent && !existing.emailVerifiedAt) {
      const { token, expiresAt } = createVerificationToken();
      const user = await prisma.user.update({
        where: { id: existing.id },
        data: {
          password: await bcrypt.hash(value.password, 12),
          fullName: value.fullName,
          graduationClass: value.graduationYear,
          emailVerificationToken: token,
          emailVerificationExpiry: expiresAt
        }
      });

      // A send failure must not fail the signup - the account exists either way
      // and the portal offers a resend.
      await sendEmailVerification(user.email, user.fullName, verificationLink(token));

      return res.status(201).json({
        message: 'Account created. Check your UCLA email for a verification link.',
        user: publicUser(user),
        token: signToken(user)
      });
    }

    if (existing) {
      // Deliberately explicit rather than the generic "if that email exists"
      // wording /forgot-password uses. This is a signup form: telling someone
      // their address is already registered is the only way they can act on it,
      // and it matches POST /register. The disclosure is that a given ucla.edu
      // address has an account here, which is the same thing the login form
      // leaks to anyone who tries it.
      return res.status(400).json({ error: 'An account already exists for this email. Sign in instead.' });
    }

    const { token, expiresAt } = createVerificationToken();

    const user = await prisma.user.create({
      data: {
        email: value.email,
        password: await bcrypt.hash(value.password, 12),
        fullName: value.fullName,
        // Four bare digits, not "Spring 2027" - see sanitizeExternalSignup.
        graduationClass: value.graduationYear,
        role: 'USER',
        isExternalTalent: true,
        emailVerificationToken: token,
        emailVerificationExpiry: expiresAt
      }
    });

    await sendEmailVerification(user.email, user.fullName, verificationLink(token));

    // A session is issued before verification on purpose: it lets the portal
    // render a real "verify your email" state and a working resend button
    // instead of a dead end. It grants nothing - every route that puts a resume
    // in front of a partner checks emailVerifiedAt, not the token.
    res.status(201).json({
      message: 'Account created. Check your UCLA email for a verification link.',
      user: publicUser(user),
      token: signToken(user)
    });
  } catch (error) {
    console.error('External registration error:', error);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

router.post('/verify-email', async (req, res) => {
  try {
    const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
    if (!token) {
      return res.status(400).json({ error: 'Missing verification token' });
    }

    const user = await prisma.user.findUnique({ where: { emailVerificationToken: token } });

    if (!user) {
      return res.status(400).json({ error: 'That verification link is invalid or has already been used.' });
    }

    if (!user.emailVerificationExpiry || user.emailVerificationExpiry < new Date()) {
      return res.status(400).json({
        error: 'That verification link has expired. Sign in and request a new one.',
        expired: true
      });
    }

    const verified = await prisma.user.update({
      where: { id: user.id },
      data: {
        emailVerifiedAt: user.emailVerifiedAt || new Date(),
        // Cleared so the link is single-use. A second click gets the "invalid or
        // already used" message above, which is the honest answer.
        emailVerificationToken: null,
        emailVerificationExpiry: null
      }
    });

    invalidateUserCache(verified.id);

    res.json({
      message: 'Email verified',
      user: publicUser(verified),
      token: signToken(verified)
    });
  } catch (error) {
    console.error('Email verification error:', error);
    res.status(500).json({ error: 'Failed to verify email' });
  }
});

router.post('/resend-verification', async (req, res) => {
  // Unlike the signup form, this one reveals nothing: the response is identical
  // whether the address is unknown, already verified, or was just re-sent.
  const generic = { message: 'If that account needs verification, a new link is on its way.' };

  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) {
      return res.status(400).json({ error: 'Enter your UCLA email address.' });
    }

    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || user.emailVerifiedAt || !user.isExternalTalent) {
      return res.json(generic);
    }

    const issuedAt = tokenIssuedAt(user);
    if (issuedAt && Date.now() - issuedAt.getTime() < RESEND_MIN_INTERVAL_MS) {
      // Silently within the cooldown. Saying so would turn this into a probe
      // for "did this person just sign up?".
      return res.json(generic);
    }

    const { token, expiresAt } = createVerificationToken();
    await prisma.user.update({
      where: { id: user.id },
      data: { emailVerificationToken: token, emailVerificationExpiry: expiresAt }
    });

    await sendEmailVerification(user.email, user.fullName, verificationLink(token));

    res.json(generic);
  } catch (error) {
    console.error('Resend verification error:', error);
    res.status(500).json({ error: 'Failed to resend verification email' });
  }
});

export default router; 