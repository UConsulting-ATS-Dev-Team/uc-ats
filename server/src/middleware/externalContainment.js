import { resolveUserFromRequest } from './auth.js';

/**
 * Containment for the CLIENT role (Talent Partner Network buyers).
 *
 * Why this is global rather than a gate added to each route file: several route
 * files - candidate.js, public.js, featureRequests.js, files.js, users.js, and
 * parts of member.js, reviewTeams.js and applications.js - mount a bare
 * requireAuth with no role check. Patching each one would be a denylist by
 * omission: the next route file someone adds is a hole, and nothing fails when
 * it appears. One middleware plus one test file gives a single assertion
 * surface - "a CLIENT gets 403 on everything not listed here".
 *
 * The per-route gates stay exactly as they are. requireClient on /api/client is
 * the real gate; this is defense in depth.
 *
 * The rule this middleware must never break: it is completely transparent to
 * anything that is not a confirmed, active CLIENT. A missing, malformed or
 * expired token falls through untouched so the downstream requireAuth still
 * produces its own 401 - turning an authentication failure into a 403 would
 * both leak information and break every existing test.
 */

// Endpoints a CLIENT legitimately needs outside the portal itself.
const CLIENT_ALLOWED_EXACT = new Set([
  '/api/auth/login',
  '/api/auth/verify',
  '/api/health'
]);

const CLIENT_ALLOWED_PREFIX = '/api/client/';

export const externalContainment = async (req, res, next) => {
  // Never touch SPA static assets or the client-side routing fallback. This is
  // also why the middleware is mounted top-level rather than at app.use('/api',
  // ...) - under a mount path req.path would be relative to it and every string
  // in the allowlist would silently stop matching.
  if (!req.path.startsWith('/api/')) {
    return next();
  }

  const result = await resolveUserFromRequest(req);

  // No token, bad token, expired token, deleted or deactivated user: not our
  // business. Downstream produces the right 401.
  if (!result.user) {
    return next();
  }

  // Cache the resolution for the downstream requireAuth so this costs no extra
  // query for any role.
  req.user = result.user;

  if (result.user.role !== 'CLIENT') {
    return next();
  }

  const allowed =
    CLIENT_ALLOWED_EXACT.has(req.path) ||
    req.path.startsWith(CLIENT_ALLOWED_PREFIX);

  if (allowed) {
    return next();
  }

  return res.status(403).json({
    error: 'This account does not have access to that area'
  });
};

export default externalContainment;
