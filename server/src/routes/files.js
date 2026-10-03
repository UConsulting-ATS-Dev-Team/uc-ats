import express from 'express';
import { getFileStream, getFileMetadata } from '../services/google/drive.js';
import { requireAuth } from '../middleware/auth.js';
import { acceptDocumentLink, signDocumentLink } from '../services/documentLinks.js';
import { parseByteRange } from '../services/byteRange.js';
import { rememberFileAccess, rememberFileMetadata } from '../services/documentStreamCache.js';
import { getHeadshotThumbnail, parseThumbnailSize, THUMBNAIL_SIZES } from '../services/headshotThumbnails.js';
import prisma from '../prismaClient.js';

const router = express.Router();

// The two routes a signed link may open (services/documentLinks.js).
const LINK_PATH = /^\/([^/]+)\/(pdf|image)$/;
const linkedFile = (req) => {
  const match = LINK_PATH.exec(req.path);
  return match ? `file:${decodeURIComponent(match[1])}` : null;
};

router.use(acceptDocumentLink(linkedFile), requireAuth);

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
    res.json({ access: signDocumentLink(`file:${fileId}`, req.user.id) });
  } catch (error) {
    console.error('Error signing file link:', error);
    res.status(500).json({ error: 'Failed to create link' });
  }
});

// A headshot's URL names one Drive file, whose content never changes (a new
// photo is a new file), so the browser may keep it for a week. The ETag from
// res.send lets it revalidate cheaply after that.
const IMAGE_CACHE_CONTROL = 'private, max-age=604800';

router.get('/:fileId/image', async (req, res) => {
  try {
    const { fileId } = req.params;

    if (!fileId || fileId.trim().length === 0) {
      return res.status(400).json({ error: 'Invalid file ID' });
    }

    // `?size=` asks for a small copy for an avatar (services/headshotThumbnails.js);
    // without it, the original.
    const size = parseThumbnailSize(req.query.size);
    if (size === false) {
      return res.status(400).json({ error: `size must be one of ${THUMBNAIL_SIZES.join(', ')}` });
    }

    // Checked on every request, before Drive is asked anything and before any
    // cached thumbnail is handed out, so a headshot removed from an application
    // stops being served at once. The browser cache is what spares repeats.
    const allowed = await authorizeFileAccess(fileId, req.user);
    if (!allowed) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    if (size) {
      const thumbnail = await getHeadshotThumbnail(fileId, size, { download: (id) => getFileStream(id) });
      if (thumbnail) {
        res.setHeader('Content-Type', thumbnail.contentType);
        res.setHeader('Cache-Control', IMAGE_CACHE_CONTROL);
        return res.send(thumbnail.body);
      }
      // Not an image sharp can read (an iPhone HEIC, say): stream the original,
      // exactly as before thumbnails existed.
    }

    const meta = await rememberFileMetadata(fileId, () => getFileMetadata(fileId));
    const fileStream = await getFileStream(fileId);

    res.setHeader('Content-Type', meta?.mimeType || 'image/jpeg');
    res.setHeader('Cache-Control', IMAGE_CACHE_CONTROL);

    fileStream.on('error', (error) => {
      console.error('Error streaming image:', error);
      res.destroy(error);
    });
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

    // A video asks for this route once per range, so both answers are remembered
    // for the viewing (services/documentStreamCache.js). Access is settled before
    // Drive is asked anything, so a caller who may not open the file cannot spend
    // Drive quota on it either.
    const allowed = await rememberFileAccess(req.user, fileId, () => authorizeFileAccess(fileId, req.user));
    if (!allowed) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const meta = await rememberFileMetadata(fileId, () => getFileMetadata(fileId));
    // Drive reports size as a decimal string; missing for Google Docs exports.
    const size = meta?.size != null ? Number(meta.size) : NaN;
    // Videos (stored behind this route too) arrive as a series of ranges; see
    // services/byteRange.js for why each answer is capped.
    const range = parseByteRange(req.headers.range, size);

    res.setHeader('Content-Type', meta?.mimeType || 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    if (Number.isFinite(size)) res.setHeader('Accept-Ranges', 'bytes');

    if (range === 'unsatisfiable') {
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }

    const fileStream = await getFileStream(fileId, range ? { range } : {});
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
    } else if (Number.isFinite(size)) {
      res.setHeader('Content-Length', String(size));
    }

    fileStream.on('error', (error) => {
      console.error('Error streaming file:', error);
      res.destroy(error);
    });
    fileStream.pipe(res);

  } catch (error) {
    console.error('Error serving PDF:', error);
    const statusCode = error.statusCode || (error.code === 'FILE_NOT_FOUND' ? 404 : error.code === 'ACCESS_DENIED' ? 403 : 500);
    res.status(statusCode).json({ error: 'Failed to serve PDF' });
  }
});

export default router;
