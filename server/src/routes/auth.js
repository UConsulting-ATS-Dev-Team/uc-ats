import express from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import config from '../config.js';
import crypto from 'crypto';
import { sendPasswordResetEmail, sendPasswordResetConfirmationEmail } from '../services/emailNotifications.js';

const router = express.Router(); 

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
    const { password: _, resetToken: __, resetTokenExpiry: ___, ...userWithoutPassword } = user;
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
    const { password: _, resetToken: __, resetTokenExpiry: ___, ...userWithoutPassword } = user;
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
    
    const { password: _, resetToken: __, resetTokenExpiry: ___, ...userWithoutPassword } = user;
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
    const { password: _, resetToken: __, resetTokenExpiry: ___, ...userWithoutPassword } = user;
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

export default router; 