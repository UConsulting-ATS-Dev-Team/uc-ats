import express from 'express';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import { requireAuth, invalidateUserCache } from '../middleware/auth.js';
import prisma from '../prismaClient.js';
import { revokeTalentPoolAccess } from '../services/talentPoolAccess.js';
import { normalizePhoneNumber } from '../utils/phone.js';
import { storeProfileImage, removeProfileImage } from '../services/profileImageStorage.js';

const router = express.Router();

// Held in memory, not written to disk: storeProfileImage decodes and re-encodes
// it before anything is stored. The file filter is only a first pass; decoding
// is the real format check.
const PROFILE_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: PROFILE_IMAGE_MAX_BYTES },
  fileFilter: (req, file, cb) => {
    if (file.mimetype?.startsWith('image/')) return cb(null, true);
    cb(Object.assign(new Error('Only image files are allowed.'), { code: 'NOT_AN_IMAGE' }));
  }
});

// multer reports a rejected file by calling next(err), which skips the route's
// own try/catch and ends in Express's default HTML 500. Answer 400 with a
// message the profile page can show instead.
const profileImageUpload = (req, res, next) => {
  upload.single('profileImage')(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File size must be less than 10MB.' });
    }
    return res.status(400).json({ error: err.message || 'Upload failed.' });
  });
};

// Get all users (admin only)
router.get('/', requireAuth, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied. Admin only.' });
    }

    const users = await prisma.user.findMany({
      select: {
        id: true,
        email: true,
        fullName: true,
        graduationClass: true,
        profileImage: true,
        role: true,
        isActive: true,
        deactivatedAt: true,
        createdAt: true,
        _count: {
          select: {
            comments: true,
            resumeScores: true,
            coverLetterScores: true,
            videoScores: true,
            evaluations: true
          }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    res.json(users);
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// Get user by ID
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if user is admin or requesting their own data
    if (req.user.role !== 'ADMIN' && req.user.id !== id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: {
        id: true,
        email: true,
        fullName: true,
        graduationClass: true,
        profileImage: true,
        role: true,
        isActive: true,
        deactivatedAt: true,
        createdAt: true,
        _count: {
          select: {
            comments: true,
            resumeScores: true,
            coverLetterScores: true,
            videoScores: true,
            evaluations: true
          }
        }
      }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json(user);
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

// Update user role (admin only)
router.patch('/:id/role', requireAuth, async (req, res) => {
  try {
    console.log('[PATCH /api/users/:id/role] Request received:', {
      userId: req.user?.id,
      userRole: req.user?.role,
      targetUserId: req.params.id,
      newRole: req.body.role
    });

    // Check if user is admin
    if (req.user.role !== 'ADMIN') {
      console.log('[PATCH /api/users/:id/role] Access denied - not admin');
      return res.status(403).json({ error: 'Access denied. Admin only.' });
    }

    const { id } = req.params;
    const { role } = req.body;

    if (!role) {
      console.log('[PATCH /api/users/:id/role] Missing role in request body');
      return res.status(400).json({ error: 'Role is required' });
    }

    // Validate role
    // CLIENT is deliberately absent. A Talent Partner Network client must be
    // created through POST /api/admin/talent-pool/clients, which makes the User
    // and the TalentPartnerClient row in one transaction. Allowing the role to
    // be set here would permit a CLIENT with no partner row - an account that
    // can log in and then hit a confusing 403 on every portal request.
    const validRoles = ['USER', 'ADMIN', 'MEMBER'];
    if (!validRoles.includes(role)) {
      console.log('[PATCH /api/users/:id/role] Invalid role:', role);
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Prevent admin from changing their own role
    if (req.user.id === id) {
      console.log('[PATCH /api/users/:id/role] Cannot change own role');
      return res.status(400).json({ error: 'Cannot change your own role' });
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: { role },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        createdAt: true, profileImage: true }
    });

    // Without this the old role keeps authorizing requests for up to the cache
    // TTL - five minutes in which a demoted admin is still an admin.
    invalidateUserCache(id);

    console.log('[PATCH /api/users/:id/role] Role updated successfully:', updatedUser);
    res.json(updatedUser);
  } catch (error) {
    console.error('[PATCH /api/users/:id/role] Error updating user role:', error);
    res.status(500).json({ error: 'Failed to update user role' });
  }
});

// Update user information
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { fullName, graduationClass, email, phoneNumber } = req.body;
    
    // Check if user is admin or updating their own data
    if (req.user.role !== 'ADMIN' && req.user.id !== id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const updateData = {};
    if (fullName) updateData.fullName = fullName;
    if (graduationClass !== undefined) updateData.graduationClass = graduationClass;
    if (email) updateData.email = email;
    if (phoneNumber !== undefined) {
      // Admins only, even on your own record. An admin picks iMessage recipients
      // by name and never sees the number behind them, so a member who can write
      // their own phoneNumber can point an admin's message at a third party and
      // the composer will address it there without anyone noticing. The number is
      // a communication destination the org trusts, not a profile field its owner
      // gets to assert. Set it in User Management or through the roster import.
      if (req.user.role !== 'ADMIN') {
        return res.status(403).json({ error: 'Only an admin can change a phone number.' });
      }
      // Empty clears it; anything else must parse, since iMessage dials it as-is.
      if (phoneNumber === null || String(phoneNumber).trim() === '') {
        updateData.phoneNumber = null;
      } else {
        const normalized = normalizePhoneNumber(phoneNumber);
        if (!normalized) {
          return res.status(400).json({ error: 'Phone number is not valid' });
        }
        updateData.phoneNumber = normalized;
      }
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        email: true,
        fullName: true,
        graduationClass: true,
        profileImage: true,
        phoneNumber: true,
        role: true,
        createdAt: true
      }
    });

    res.json(updatedUser);
  } catch (error) {
    console.error('Error updating user:', error);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

// Upload profile image
router.post('/:id/profile-image', requireAuth, profileImageUpload, async (req, res) => {
  try {
    const { id } = req.params;

    // Check if user is admin or uploading their own image
    if (req.user.role !== 'ADMIN' && req.user.id !== id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const existing = await prisma.user.findUnique({ where: { id }, select: { profileImage: true } });
    if (!existing) {
      return res.status(404).json({ error: 'User not found' });
    }

    const fileUrl = await storeProfileImage(id, req.file.buffer);

    const updatedUser = await prisma.user.update({
      where: { id },
      data: { profileImage: fileUrl },
      select: {
        id: true,
        email: true,
        fullName: true,
        profileImage: true,
        role: true
      }
    });
    invalidateUserCache(id);

    if (existing.profileImage && existing.profileImage !== fileUrl) {
      await removeProfileImage(existing.profileImage);
    }

    res.json({
      message: 'Profile image uploaded successfully',
      user: updatedUser
    });
  } catch (error) {
    if (error.code === 'IMAGE_UNREADABLE') {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    if (error.code === 'STORAGE_NOT_CONFIGURED') {
      return res.status(503).json({ error: error.message, code: error.code });
    }
    console.error('Error uploading profile image:', error);
    res.status(500).json({ error: 'Failed to upload profile image' });
  }
});

// Deactivate a single user (admin only)
// Accounts are never hard-deleted: their grading history, evaluations and
// interview records stay intact, the account just can no longer sign in.
router.patch('/:id/deactivate', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied. Admin only.' });
    }

    const { id } = req.params;

    if (req.user.id === id) {
      return res.status(400).json({ error: 'Cannot deactivate your own account' });
    }

    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, isActive: true }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.isActive === false) {
      return res.status(400).json({ error: 'User is already deactivated' });
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: {
        isActive: false,
        deactivatedAt: new Date(),
        deactivatedBy: req.user.id
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        deactivatedAt: true
      }
    });

    // Cut the existing session immediately rather than after the cache TTL
    invalidateUserCache(id);

    // Their resume stops being assignable via the pool gates, but assignments
    // already handed to a client are snapshots and would otherwise outlive the
    // deactivation. Reported rather than thrown: a revocation failure must not
    // leave the account half-deactivated.
    let talentPoolAssignmentsRevoked = 0;
    try {
      ({ revoked: talentPoolAssignmentsRevoked } = await revokeTalentPoolAccess([id], req.user.id));
    } catch (error) {
      console.error('[deactivate user] talent pool revocation failed', error);
    }

    res.json({
      message: 'User deactivated successfully',
      user: updatedUser,
      talentPoolAssignmentsRevoked,
    });
  } catch (error) {
    console.error('Error deactivating user:', error);
    res.status(500).json({ error: 'Failed to deactivate user' });
  }
});

// Reactivate a single user (admin only)
router.patch('/:id/reactivate', requireAuth, async (req, res) => {
  try {
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied. Admin only.' });
    }

    const { id } = req.params;

    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, isActive: true }
    });

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    if (user.isActive !== false) {
      return res.status(400).json({ error: 'User is already active' });
    }

    const updatedUser = await prisma.user.update({
      where: { id },
      data: {
        isActive: true,
        deactivatedAt: null,
        deactivatedBy: null
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        deactivatedAt: true
      }
    });

    invalidateUserCache(id);

    res.json({ message: 'User reactivated successfully', user: updatedUser });
  } catch (error) {
    console.error('Error reactivating user:', error);
    res.status(500).json({ error: 'Failed to reactivate user' });
  }
});

// Create new user (admin only)
router.post('/', requireAuth, async (req, res) => {
  try {
    // Check if user is admin
    if (req.user.role !== 'ADMIN') {
      return res.status(403).json({ error: 'Access denied. Admin only.' });
    }

    const { email, password, fullName, graduationClass, role } = req.body;

    // Validate required fields
    if (!email || !password || !fullName) {
      return res.status(400).json({ error: 'Email, password, and full name are required' });
    }

    // Validate role
    // CLIENT is deliberately absent. A Talent Partner Network client must be
    // created through POST /api/admin/talent-pool/clients, which makes the User
    // and the TalentPartnerClient row in one transaction. Allowing the role to
    // be set here would permit a CLIENT with no partner row - an account that
    // can log in and then hit a confusing 403 on every portal request.
    const validRoles = ['USER', 'ADMIN', 'MEMBER'];
    if (role && !validRoles.includes(role)) {
      return res.status(400).json({ error: 'Invalid role' });
    }

    // Check if email already exists
    const existingUser = await prisma.user.findUnique({
      where: { email }
    });

    if (existingUser) {
      return res.status(400).json({ error: 'Email already exists' });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 12);

    // Create user
    const newUser = await prisma.user.create({
      data: {
        email,
        password: hashedPassword,
        fullName,
        graduationClass,
        role: role || 'USER'
      },
      select: {
        id: true,
        email: true,
        fullName: true,
        graduationClass: true,
        role: true,
        createdAt: true, profileImage: true }
    });

    res.status(201).json({
      message: 'User created successfully',
      user: newUser
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

export default router;
