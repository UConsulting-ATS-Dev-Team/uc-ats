import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import bcrypt from 'bcryptjs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { requireAuth, invalidateUserCache } from '../middleware/auth.js';
import prisma from '../prismaClient.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = express.Router();

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const uploadDir = path.join(__dirname, '../../uploads/profile-images');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, 'profile-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 5 * 1024 * 1024 // 5MB limit
  },
  fileFilter: function (req, file, cb) {
    const allowedTypes = /jpeg|jpg|png|gif/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    
    if (mimetype && extname) {
      return cb(null, true);
    } else {
      cb(new Error('Only image files are allowed!'));
    }
  }
});

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
    const { fullName, graduationClass, email } = req.body;
    
    // Check if user is admin or updating their own data
    if (req.user.role !== 'ADMIN' && req.user.id !== id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    const updateData = {};
    if (fullName) updateData.fullName = fullName;
    if (graduationClass !== undefined) updateData.graduationClass = graduationClass;
    if (email) updateData.email = email;

    const updatedUser = await prisma.user.update({
      where: { id },
      data: updateData,
      select: {
        id: true,
        email: true,
        fullName: true,
        graduationClass: true,
        profileImage: true,
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
router.post('/:id/profile-image', requireAuth, upload.single('profileImage'), async (req, res) => {
  try {
    const { id } = req.params;
    
    // Check if user is admin or uploading their own image
    if (req.user.role !== 'ADMIN' && req.user.id !== id) {
      return res.status(403).json({ error: 'Access denied.' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    console.log('File uploaded:', req.file);
    console.log('File path:', req.file.path);

    // Generate file URL
    const fileUrl = `/api/uploads/profile-images/${req.file.filename}`;
    console.log('Generated file URL:', fileUrl);

    // Update user's profile image
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

    console.log('Updated user:', updatedUser);

    res.json({
      message: 'Profile image uploaded successfully',
      user: updatedUser
    });
  } catch (error) {
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

    res.json({ message: 'User deactivated successfully', user: updatedUser });
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
