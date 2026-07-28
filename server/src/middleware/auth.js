import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import config from '../config.js';

// Simple in-memory cache for user data to reduce DB calls
const userCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Middleware to verify JWT token and attach user to request
export const requireAuth = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
      return res.status(401).json({ error: 'Authentication required' });
    }
    
    const decoded = jwt.verify(token, config.jwtSecret);
    const userId = decoded.userId;
    
    // Check cache first to reduce DB calls
    const cached = userCache.get(userId);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      req.user = cached.user;
      return next();
    }
    
    // Only query DB if not in cache or cache expired
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        fullName: true,
        role: true,
        isActive: true,
        graduationClass: true,
        studentId: true,
        profileImage: true,
        createdAt: true
        // Explicitly exclude password
      }
    });
    
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    if (user.isActive === false) {
      userCache.delete(userId);
      return res.status(401).json({ error: 'Account deactivated' });
    }
    
    // Cache the user data
    userCache.set(userId, {
      user,
      timestamp: Date.now()
    });
    
    req.user = user;
    next();
    
  } catch (error) {
    console.error('Auth middleware error:', error);
    res.status(401).json({ error: 'Invalid token' });
  }
};

// Clean up expired cache entries periodically to prevent memory leaks
setInterval(() => {
  const now = Date.now();
  for (const [userId, cached] of userCache.entries()) {
    if ((now - cached.timestamp) > CACHE_TTL) {
      userCache.delete(userId);
    }
  }
}, CACHE_TTL); // Clean up every 5 minutes

// Middleware to require admin role
export const requireAdmin = async (req, res, next) => {
  if (req.user?.role !== 'ADMIN') {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

// Middleware to require admin or member role (exclude USER/candidates)
export const requireAdminOrMember = async (req, res, next) => {
  if (req.user?.role !== 'ADMIN' && req.user?.role !== 'MEMBER') {
    return res.status(403).json({ error: 'Admin or member access required' });
  }
  next();
}; 