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
  removeDocument,
} from '../services/applicationDocuments.js';
import { isStaff, ownApplicationWhere } from '../utils/applicationOwnership.js';
import { isApplicationLocked, sendRecordLocked } from '../utils/lockedRecords.js';

const router = express.Router();

const LINK_PATH = /^\/([^/]+)\/file$/;
const linkedDocument = (req) => {
  const match = LINK_PATH.exec(req.path);
  return match ? `application-document:${decodeURIComponent(match[1])}` : null;
};

router.use(acceptDocumentLink(linkedDocument), requireAuth);

const referencedBy = (id) => {
  const url = documentUrl(id);
  return { OR: [{ blindResumeUrl: url }, { videoUrl: url }] };
};

// A request that arrived on a signed link rather than a sign-in.
const cameByLink = (req) => !req.headers.authorization && typeof req.query.access === 'string';

// Staff may open a document some application names, an applicant only one their
// own application names. An uploaded document no application points at is
// served to nobody.
//
// A sealed application's documents are sealed with it: staff need an executive
// unlock. The unlock travels as a header, which a signed link cannot carry, so
// it is checked when the link is signed and a request arriving on that link is
// not asked again. The link lasts 15 minutes; an unlock lasts 30.
//
// Answers 'ok', 'forbidden' or 'locked'.
async function documentAccess(req, id) {
  const referenced = referencedBy(id);

  if (isStaff(req.user)) {
    const application = await prisma.application.findFirst({ where: referenced, select: { id: true } });
    if (!application) return 'forbidden';
    if (!cameByLink(req) && (await isApplicationLocked(req, application.id))) return 'locked';
    return 'ok';
  }

  const owned = ownApplicationWhere(req.user);
  if (!owned) return 'forbidden';
  const application = await prisma.application.findFirst({
    where: { AND: [owned, referenced] },
    select: { id: true },
  });
  return application ? 'ok' : 'forbidden';
}

// Sends the refusal and answers false when the caller may not open the document.
async function allowDocument(req, res, id) {
  const access = await documentAccess(req, id);
  if (access === 'ok') return true;
  if (access === 'locked') sendRecordLocked(res);
  else res.status(403).json({ error: 'Forbidden' });
  return false;
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

// DELETE /api/application-documents/video-uploads/:documentId
// The form was closed, or another video chosen, after this one was uploaded.
// Only a video no application names is removed.
router.delete('/video-uploads/:documentId', requireAdmin, async (req, res) => {
  try {
    const document = parseDocumentId(req.params.documentId);
    if (!document?.isVideo) return res.status(404).json({ error: 'Document not found' });
    const inUse = await prisma.application.findFirst({ where: referencedBy(document.id), select: { id: true } });
    if (inUse) return res.status(409).json({ error: 'This video belongs to an application.' });
    await removeDocument(document.id);
    res.json({ removed: true });
  } catch (error) {
    console.error('[DELETE /api/application-documents/video-uploads/:documentId]', error);
    res.status(500).json({ error: 'Failed to remove the video' });
  }
});

// POST /api/application-documents/:documentId/link
// A short-lived link that opens the file below in a new tab or a <video>
// (services/documentLinks.js). Same access rule as the file.
router.post('/:documentId/link', async (req, res) => {
  try {
    const document = parseDocumentId(req.params.documentId);
    if (!document) return res.status(404).json({ error: 'Document not found' });
    if (!(await allowDocument(req, res, document.id))) return;
    res.json({ access: signDocumentLink(`application-document:${document.id}`, req.user.id) });
  } catch (error) {
    console.error('[POST /api/application-documents/:documentId/link]', error);
    res.status(500).json({ error: 'Failed to create link' });
  }
});

// GET /api/application-documents/:documentId/file
// A video asks for this once per range, each answered with at most 4 MB
// (services/byteRange.js); a PDF is small enough to arrive whole. A request
// with no Range gets the whole file, as /api/files does: every player in the
// app asks in ranges, and RFC 9110 leaves no way to answer a plain GET in part.
router.get('/:documentId/file', async (req, res) => {
  try {
    const document = parseDocumentId(req.params.documentId);
    if (!document) return res.status(404).json({ error: 'Document not found' });
    if (!(await allowDocument(req, res, document.id))) return;

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
