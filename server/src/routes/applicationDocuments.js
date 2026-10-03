import express from 'express';
import prisma from '../prismaClient.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { acceptDocumentLink, signDocumentLink } from '../services/documentLinks.js';
import { parseByteRange } from '../services/byteRange.js';
import { storageErrorResponse } from '../services/resumeStorage.js';
import {
  createVideoUpload,
  documentSize,
  documentUrl,
  openDocument,
  parseDocumentId,
} from '../services/applicationDocuments.js';
import { isStaff, ownApplicationWhere } from '../utils/applicationOwnership.js';

const router = express.Router();

const LINK_PATH = /^\/([^/]+)\/file$/;
const linkedDocument = (req) => {
  const match = LINK_PATH.exec(req.path);
  return match ? `application-document:${decodeURIComponent(match[1])}` : null;
};

router.use(acceptDocumentLink(linkedDocument), requireAuth);

// The same rule routes/files.js applies to a Drive file: staff may open a
// document some application names, an applicant only one their own application
// names. An uploaded document no application points at is served to nobody.
async function authorizeDocumentAccess(id, user) {
  const url = documentUrl(id);
  const referenced = { OR: [{ blindResumeUrl: url }, { videoUrl: url }] };

  if (isStaff(user)) {
    return Boolean(await prisma.application.findFirst({ where: referenced, select: { id: true } }));
  }

  const owned = ownApplicationWhere(user);
  if (!owned) return false;
  return Boolean(
    await prisma.application.findFirst({ where: { AND: [owned, referenced] }, select: { id: true } })
  );
}

// POST /api/application-documents/video-uploads
// Where an admin's browser should send a video for an application being added
// by hand. The video goes straight to storage; POST /api/applications/manual
// then names the returned documentId.
router.post('/video-uploads', requireAdmin, async (req, res) => {
  try {
    const { fileName, sizeBytes } = req.body || {};
    res.status(201).json(await createVideoUpload({ fileName, sizeBytes: Number(sizeBytes) }));
  } catch (error) {
    if (error.code === 'UNSUPPORTED_VIDEO' || error.code === 'VIDEO_TOO_LARGE') {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    const storageFault = storageErrorResponse(error);
    if (storageFault) return res.status(storageFault.status).json(storageFault.body);
    console.error('[POST /api/application-documents/video-uploads]', error);
    res.status(500).json({ error: 'Failed to prepare the video upload' });
  }
});

// POST /api/application-documents/:documentId/link
// A short-lived link that opens the file below in a new tab or a <video>
// (services/documentLinks.js). Same access rule as the file.
router.post('/:documentId/link', async (req, res) => {
  try {
    const document = parseDocumentId(req.params.documentId);
    if (!document) return res.status(404).json({ error: 'Document not found' });
    if (!(await authorizeDocumentAccess(document.id, req.user))) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    res.json({ access: signDocumentLink(`application-document:${document.id}`, req.user.id) });
  } catch (error) {
    console.error('[POST /api/application-documents/:documentId/link]', error);
    res.status(500).json({ error: 'Failed to create link' });
  }
});

// GET /api/application-documents/:documentId/file
// A video asks for this once per range, each answered with at most 4 MB
// (services/byteRange.js); a PDF is small enough to arrive whole.
router.get('/:documentId/file', async (req, res) => {
  try {
    const document = parseDocumentId(req.params.documentId);
    if (!document) return res.status(404).json({ error: 'Document not found' });
    if (!(await authorizeDocumentAccess(document.id, req.user))) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    const size = await documentSize(document.id);
    if (size === null) return res.status(404).json({ error: 'Document file not found' });

    const range = parseByteRange(req.headers.range, size);
    if (range === 'unsatisfiable') {
      res.setHeader('Content-Range', `bytes */${size}`);
      return res.status(416).end();
    }

    const stream = await openDocument(document.id, range || undefined);
    if (!stream) return res.status(404).json({ error: 'Document file not found' });

    res.setHeader('Content-Type', document.contentType);
    res.setHeader('Content-Disposition', 'inline');
    // Private: the answer depends on who asked. A document's bytes never change.
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Accept-Ranges', 'bytes');
    if (range) {
      res.status(206);
      res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${size}`);
      res.setHeader('Content-Length', String(range.end - range.start + 1));
    } else {
      res.setHeader('Content-Length', String(size));
    }

    stream.on('error', (error) => {
      console.error('[GET /api/application-documents/:documentId/file] stream:', error);
      res.destroy(error);
    });
    stream.pipe(res);
  } catch (error) {
    console.error('[GET /api/application-documents/:documentId/file]', error);
    res.status(500).json({ error: 'Failed to serve document' });
  }
});

export default router;
