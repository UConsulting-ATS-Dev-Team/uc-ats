import jwt from 'jsonwebtoken';
import prisma from '../prismaClient.js';
import config from '../config.js';

// Simple in-memory cache for user data to reduce DB calls
const userCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Fields every caller of resolveUserFromRequest gets. Deliberately excludes
// password, resetToken and resetTokenExpiry.
const AUTH_USER_SELECT = {
  id: true,
  email: true,
  fullName: true,
  role: true,
  isActive: true,
  graduationClass: true,
  studentId: true,
  profileImage: true,
  createdAt: true,
  // Read by the talent portal on every request to decide whether an account may
  // put a resume in front of a partner. Carried here rather than fetched per
  // route so the gate costs nothing extra - and note that verifying an email
  // must call invalidateUserCache(), or the 5-minute TTL would leave the owner
  // looking unverified to themselves right after they clicked the link.
  emailVerifiedAt: true,
  isExternalTalent: true
};

/**
 * Resolve the authenticated user for a request, reading and populating the same
 * 5-minute cache `requireAuth` uses. Returns `{ user }` on success or
 * `{ error }` where error is one of 'no-token' | 'invalid' | 'not-found' |
 * 'deactivated'.
 *
 * Extracted so the CLIENT containment middleware can ask "who is this?" before
 * the route's own requireAuth runs, without a second DB round trip and without
 * exporting the cache Map. Containment runs first, warms the cache, and
 * requireAuth then hits it.
 */
export const resolveUserFromRequest = async (req) => {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return { error: 'no-token' };
  }

  try {
    const decoded = jwt.verify(token, config.jwtSecret);
    const userId = decoded.userId;

    const cached = userCache.get(userId);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
      return { user: cached.user };
    }

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: AUTH_USER_SELECT
    });

    if (!user) {
      return { error: 'not-found' };
    }

    if (user.isActive === false) {
      userCache.delete(userId);
      return { error: 'deactivated' };
    }

    userCache.set(userId, { user, timestamp: Date.now() });

    return { user };
  } catch (error) {
    return { error: 'invalid', cause: error };
  }
};

// Middleware to verify JWT token and attach user to request
export const requireAuth = async (req, res, next) => {
  // Containment may already have resolved this request. Same cache either way,
  // but skipping re-work keeps the hot path to a single lookup.
  if (req.user) {
    return next();
  }

  const result = await resolveUserFromRequest(req);

  if (result.user) {
    req.user = result.user;
    return next();
  }

  switch (result.error) {
    case 'no-token':
      return res.status(401).json({ error: 'Authentication required' });
    case 'not-found':
      return res.status(401).json({ error: 'User not found' });
    case 'deactivated':
      return res.status(401).json({ error: 'Account deactivated' });
    default:
      console.error('Auth middleware error:', result.cause);
      return res.status(401).json({ error: 'Invalid token' });
  }
};

// Drop a user's cached record so role/status changes take effect immediately
// instead of after the 5-minute TTL
export const invalidateUserCache = (userId) => {
  if (Array.isArray(userId)) {
    userId.forEach(id => userCache.delete(id));
  } else {
    userCache.delete(userId);
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

/**
 * Gate for the Talent Partner Network portal. Allowlist-style like requireAdmin:
 * the role must be exactly CLIENT. Loads the partner row onto req.partnerClient
 * so no route handler has to, and turns an orphaned CLIENT user (one with no
 * partner row, which POST /api/admin/talent-pool/clients makes impossible) into
 * a clear message rather than a crash.
 */
export const requireClient = async (req, res, next) => {
  if (req.user?.role !== 'CLIENT') {
    return res.status(403).json({ error: 'Talent partner access required' });
  }

  try {
    const partnerClient = await prisma.talentPartnerClient.findUnique({
      where: { userId: req.user.id }
    });

    if (!partnerClient) {
      return res.status(403).json({
        error: 'Your partner account is not configured. Contact UConsulting.'
      });
    }

    req.partnerClient = partnerClient;
    next();
  } catch (error) {
    console.error('[requireClient]', error);
    res.status(500).json({ error: 'Failed to load partner account' });
  }
};
