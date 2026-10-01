import crypto from 'node:crypto';
import jwt from 'jsonwebtoken';
import config from '../config.js';
import { resolveUserById } from '../middleware/auth.js';

/**
 * Signed links: opening a document in a new tab.
 *
 * Sign-in is a bearer token the page sends as a header, and a plain link in a
 * new tab sends no header, so "Open in new tab" always answered 401. Instead
 * the page asks the document's `/link` endpoint for a token naming that one
 * document, and opens the document's URL with it as `?access=`. The browser
 * then streams the file itself, which also covers a video too large for the
 * grading preview's whole-file download.
 *
 * A document is named by a resource string such as `file:<driveId>` or
 * `resume-upload:<id>`, so a link to one kind can never open the other.
 *
 * The key is derived from JWT_SECRET rather than being JWT_SECRET, so a link
 * token is never accepted as a sign-in token and a sign-in token is never
 * accepted here. The link only stands in for the session: the route still
 * runs its own access check against the user who asked for it.
 */
const LINK_TTL = '15m';

const linkKey = () =>
  crypto.createHmac('sha256', config.jwtSecret).update('document-link').digest();

export const signDocumentLink = (resource, userId) =>
  jwt.sign({ resource, userId }, linkKey(), { expiresIn: LINK_TTL });

/**
 * Middleware that signs the request in from `?access=` when it carries no
 * Authorization header. `resourceFor(req)` names the document this request
 * is for, or null when the route is not one a link may open. Put it before
 * requireAuth, which then sees req.user and lets the request through.
 */
export const acceptDocumentLink = (resourceFor) => async (req, res, next) => {
  const access = req.query.access;
  if (req.headers.authorization || typeof access !== 'string') return next();

  const resource = resourceFor(req);
  if (!resource) return next();

  let claims;
  try {
    claims = jwt.verify(access, linkKey());
  } catch {
    return res.status(401).json({ error: 'This link has expired. Open the document again from the ATS.' });
  }
  if (claims.resource !== resource) {
    return res.status(401).json({ error: 'Invalid link' });
  }

  try {
    const result = await resolveUserById(claims.userId);
    if (!result.user) return res.status(401).json({ error: 'Invalid link' });
    req.user = result.user;
    return next();
  } catch (error) {
    return next(error);
  }
};
