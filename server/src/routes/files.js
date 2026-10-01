import crypto from 'node:crypto';
import express from 'express';
import jwt from 'jsonwebtoken';
import { getFileStream, getFileMetadata } from '../services/google/drive.js';
import { requireAuth, resolveUserById } from '../middleware/auth.js';
import prisma from '../prismaClient.js';
import config from '../config.js';

const router = express.Router();

/**
 * Signed links: opening a document in a new tab.
 *
 * Sign-in is a bearer token the page sends as a header, and a plain link in a
 * new tab sends no header, so "Open in new tab" always answered 401. Instead
 * the page asks POST /:fileId/link for a token naming that one file, and opens
 * the file URL with it as `?access=`. The browser then streams the file itself,
 * which also covers a video too large for the preview's whole-file download.
 *
 * The key is derived from JWT_SECRET rather than being JWT_SECRET, so a link
 * token is never accepted as a sign-in token and a sign-in token is never
 * accepted here. A link opens only the file it names, for LINK_TTL, and the
 * route still runs authorizeFileAccess against the user who asked for it.
 */
const LINK_TTL = '15m';
const LINK_PATH = /^\/([^/]+)\/(pdf|image)$/;

const linkKey = () =>
  crypto.createHmac('sha256', config.jwtSecret).update('file-link').digest();

export const signFileLink = (fileId, userId) =>
  jwt.sign({ fileId, userId }, linkKey(), { expiresIn: LINK_TTL });

const acceptFileLink = async (req, res, next) => {
  const access = req.query.access;
  if (req.headers.authorization || typeof access !== 'string') return next();

  const match = LINK_PATH.exec(req.path);
  if (!match) return next();

  let claims;
  try {
    claims = jwt.verify(access, linkKey());
  } catch {
    return res.status(401).json({ error: 'This link has expired. Open the document again from the ATS.' });
  }
  if (claims.fileId !== decodeURIComponent(match[1])) {
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

router.use(acceptFileLink, requireAuth);

// Verify the caller may view this Google Drive fileId. Staff (ADMIN/MEMBER) may
// view any file referenced by an application; USER role may only view files
// attached to their own application (matched via candidate email/studentId or
// the application's own email field).
/**
 * Was this Drive file ever a resume on this application?
 *
 * Replacing a resume repoints Application.resumeUrl at the new upload, so the
 * file the applicant originally submitted stops being referenced by any URL
 * column - and the reference check below then refuses it. That is how a
 * candidate came to get a 403 opening their *own* previous resume.
 *
 * ResumeUpload.sourceUrl is where that history is kept, so it is the second
 * place worth asking. Scoped to applications the caller already owns, so this
 * widens what an owner can reach and nothing else.
 */
const referencedByVersionHistory = async (fileId, applicationFilter) => {
  const upload = await prisma.resumeUpload.findFirst({
    where: {
      sourceUrl: { contains: fileId },
      ...(applicationFilter ? { application: applicationFilter } : {}),
    },
    select: { id: true },
  });
  return Boolean(upload);
};

async function authorizeFileAccess(fileId, user) {
  if (user.role === 'ADMIN' || user.role === 'MEMBER') {
    const referenced = await prisma.application.findFirst({
      where: {
        OR: [
          { resumeUrl: { contains: fileId } },
          { blindResumeUrl: { contains: fileId } },
          { headshotUrl: { contains: fileId } },
          { coverLetterUrl: { contains: fileId } },
          { videoUrl: { contains: fileId } },
        ],
      },
      select: { id: true },
    });
    if (referenced) return true;
    // Staff read the same version history, unscoped - they can already open any
    // current application document.
    return referencedByVersionHistory(fileId, null);
  }

  const ownerFilters = [];
  if (user.email) {
    ownerFilters.push({ candidate: { email: user.email } });
    ownerFilters.push({ email: user.email });
  }
  if (user.studentId) {
    ownerFilters.push({ candidate: { studentId: user.studentId } });
    ownerFilters.push({ studentId: user.studentId });
  }
  if (ownerFilters.length === 0) return false;

  const ownAndReferenced = await prisma.application.findFirst({
    where: {
      AND: [
        { OR: ownerFilters },
        {
          OR: [
            { resumeUrl: { contains: fileId } },
            { blindResumeUrl: { contains: fileId } },
            { headshotUrl: { contains: fileId } },
            { coverLetterUrl: { contains: fileId } },
            { videoUrl: { contains: fileId } },
          ],
        },
      ],
    },
    select: { id: true },
  });
  if (ownAndReferenced) return true;

  // Not a current document, but it may be a superseded one. Restricted to
  // applications this person owns.
  return referencedByVersionHistory(fileId, { OR: ownerFilters });
}

router.post('/:fileId/link', async (req, res) => {
  try {
    const { fileId } = req.params;
    const allowed = await authorizeFileAccess(fileId, req.user);
    if (!allowed) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json({ access: signFileLink(fileId, req.user.id) });
  } catch (error) {
    console.error('Error signing file link:', error);
    res.status(500).json({ error: 'Failed to create link' });
  }
});

router.get('/:fileId/image', async (req, res) => {
  try {
    const { fileId } = req.params;

    if (!fileId || fileId.trim().length === 0) {
      return res.status(400).json({ error: 'Invalid file ID' });
    }

    const allowed = await authorizeFileAccess(fileId, req.user);
    if (!allowed) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const meta = await getFileMetadata(fileId);
    const fileStream = await getFileStream(fileId);

    res.setHeader('Content-Type', meta?.mimeType || 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=3600');

    fileStream.pipe(res);

  } catch (error) {
    console.error('Error serving image:', error);
    const statusCode = error.statusCode || (error.code === 'FILE_NOT_FOUND' ? 404 : error.code === 'ACCESS_DENIED' ? 403 : 500);
    res.status(statusCode).json({ error: 'Failed to serve image' });
  }
});

router.get('/:fileId/pdf', async (req, res) => {
  try {
    const { fileId } = req.params;

    if (!fileId || fileId.trim().length === 0) {
      return res.status(400).json({ error: 'Invalid file ID' });
    }

    const allowed = await authorizeFileAccess(fileId, req.user);
    if (!allowed) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const meta = await getFileMetadata(fileId);
    const fileStream = await getFileStream(fileId);

    res.setHeader('Content-Type', meta?.mimeType || 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=3600');

    fileStream.pipe(res);

  } catch (error) {
    console.error('Error serving PDF:', error);
    const statusCode = error.statusCode || (error.code === 'FILE_NOT_FOUND' ? 404 : error.code === 'ACCESS_DENIED' ? 403 : 500);
    res.status(statusCode).json({ error: 'Failed to serve PDF' });
  }
});

export default router;
