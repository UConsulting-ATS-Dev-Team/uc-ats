import express from 'express';
import { getFileStream, getFileMetadata } from '../services/google/drive.js';
import { requireAuth } from '../middleware/auth.js';
import prisma from '../prismaClient.js';

const router = express.Router();

router.use(requireAuth);

// Verify the caller may view this Google Drive fileId. Staff (ADMIN/MEMBER) may
// view any file referenced by an application; USER role may only view files
// attached to their own application (matched via candidate email/studentId or
// the application's own email field).
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
    return Boolean(referenced);
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
  return Boolean(ownAndReferenced);
}

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
