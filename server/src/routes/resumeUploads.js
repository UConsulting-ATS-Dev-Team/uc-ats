import express from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import fsPromises from 'fs/promises';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import prisma from '../prismaClient.js';
import { putResume, getResume, removeResume } from '../services/resumeStorage.js';
import { requireAuth } from '../middleware/auth.js';
import { isOwnedBy, isStaff } from '../utils/applicationOwnership.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const router = express.Router();

// Replacement resumes are held next to case files, OUTSIDE the statically served
// `uploads/` directory, so the only way to read one is through the authorized
// proxy at the bottom of this file.
const STORAGE_DIR = path.join(__dirname, '../../storage');
const RESUME_ROOT = path.join(STORAGE_DIR, 'resumes');

export const MAX_RESUME_BYTES = 10 * 1024 * 1024;

// Kept in memory so nothing lands on disk until the deadline and ownership
// checks have passed and the row it belongs to has an id.
const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RESUME_BYTES, files: 1 },
  fileFilter(req, file, cb) {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Your resume must be a PDF'));
  },
});

const applicationWithOwnership = {
  id: true,
  email: true,
  studentId: true,
  resumeUrl: true,
  submittedAt: true,
  candidate: { select: { email: true, studentId: true } },
  cycle: { select: { id: true, name: true, isActive: true, resumeDeadline: true } },
};

// `RecruitingCycle.resumeDeadline` is a free-text column. Cycles created through
// the timeline bootstrap store an ISO date (YYYY-MM-DD); older rows can hold
// prose like "Oct 4th, Morning". A parseable date closes the window at the end
// of that day in server time; anything unparseable is treated as "no deadline
// recorded" rather than locking candidates out over a formatting quirk.
export function resumeDeadlineAt(cycle) {
  const raw = cycle?.resumeDeadline?.trim();
  if (!raw) return null;

  const isoDay = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (isoDay) {
    const [, year, month, day] = isoDay;
    return new Date(Number(year), Number(month) - 1, Number(day), 23, 59, 59, 999);
  }

  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    console.warn(
      `[resume-uploads] Cycle ${cycle.id} has an unparseable resumeDeadline (${JSON.stringify(raw)}); treating the replacement window as open.`
    );
    return null;
  }
  return parsed;
}

// Whether THIS user may replace THIS application's resume right now, and why not
// when they may not. The reason is candidate-facing copy.
export function replacementWindow(application, user, now = new Date()) {
  const deadline = resumeDeadlineAt(application.cycle);
  const base = { deadline, deadlineLabel: application.cycle?.resumeDeadline || null };

  if (!isOwnedBy(application, user)) {
    return { ...base, canReplace: false, reason: 'Only the applicant can replace this resume.' };
  }
  if (!application.cycle) {
    return { ...base, canReplace: false, reason: 'This application is not attached to a recruiting cycle.' };
  }
  if (!application.cycle.isActive) {
    return {
      ...base,
      canReplace: false,
      reason: `${application.cycle.name} has closed, so its documents can no longer be changed.`,
    };
  }
  if (deadline && now.getTime() > deadline.getTime()) {
    return {
      ...base,
      canReplace: false,
      reason: `The resume deadline for ${application.cycle.name} has passed.`,
    };
  }
  return { ...base, canReplace: true, reason: null };
}

// An application that has never been replaced has no rows: its one and only
// version is the file the application form delivered. Represent that implicitly
// rather than backfilling every historical application.
function buildVersions(application, rows) {
  if (rows.length === 0) {
    if (!application.resumeUrl) return [];
    return [
      {
        id: null,
        url: application.resumeUrl,
        originalName: null,
        sizeBytes: null,
        uploadedAt: application.submittedAt,
        replacedByCandidate: false,
        isCurrent: true,
      },
    ];
  }

  return rows.map((row) => ({
    id: row.id,
    url: row.sourceUrl,
    originalName: row.originalName,
    sizeBytes: row.sizeBytes,
    uploadedAt: row.uploadedAt,
    replacedByCandidate: Boolean(row.storagePath),
    isCurrent: row.supersededAt === null,
  }));
}

const versionRows = (applicationId) =>
  prisma.resumeUpload.findMany({
    where: { applicationId },
    orderBy: { uploadedAt: 'asc' },
  });

async function loadApplication(res, applicationId, user) {
  const application = await prisma.application.findUnique({
    where: { id: applicationId },
    select: applicationWithOwnership,
  });

  if (!application) {
    res.status(404).json({ error: 'Application not found' });
    return null;
  }
  if (!isOwnedBy(application, user) && !isStaff(user)) {
    res.status(403).json({ error: 'Forbidden' });
    return null;
  }
  return application;
}

// GET /api/resume-uploads/applications/:applicationId
// Every version of this application's resume, plus whether the viewer may add
// another one. Readable by the applicant and by staff.
router.get('/applications/:applicationId', requireAuth, async (req, res) => {
  try {
    const application = await loadApplication(res, req.params.applicationId, req.user);
    if (!application) return;

    const rows = await versionRows(application.id);
    const window = replacementWindow(application, req.user);

    res.json({
      applicationId: application.id,
      currentResumeUrl: application.resumeUrl,
      maxBytes: MAX_RESUME_BYTES,
      canReplace: window.canReplace,
      reason: window.reason,
      deadline: window.deadline ? window.deadline.toISOString() : null,
      deadlineLabel: window.deadlineLabel,
      versions: buildVersions(application, rows),
    });
  } catch (error) {
    console.error('[GET /api/resume-uploads/applications/:applicationId]', error);
    res.status(500).json({ error: 'Failed to load resume history' });
  }
});

// POST /api/resume-uploads/applications/:applicationId
// Replace the resume on an application with a freshly uploaded PDF. Candidates
// only: staff replacing an applicant's documents is deliberately not a thing.
router.post(
  '/applications/:applicationId',
  requireAuth,
  resumeUpload.single('resume'),
  async (req, res) => {
    let writtenPath = null;
    try {
      const application = await prisma.application.findUnique({
        where: { id: req.params.applicationId },
        select: applicationWithOwnership,
      });
      if (!application) return res.status(404).json({ error: 'Application not found' });

      // Ownership is checked before the window so staff get "not yours", not a
      // deadline message about someone else's application.
      if (!isOwnedBy(application, req.user)) {
        return res.status(403).json({ error: 'Only the applicant can replace this resume.' });
      }

      const window = replacementWindow(application, req.user);
      if (!window.canReplace) return res.status(403).json({ error: window.reason });

      if (!req.file) return res.status(400).json({ error: 'No resume file was uploaded' });
      // Trust the bytes, not the declared content type.
      if (!req.file.buffer.subarray(0, 5).equals(Buffer.from('%PDF-'))) {
        return res.status(400).json({ error: 'That file is not a readable PDF' });
      }

      const uploadId = crypto.randomUUID();
      const relativePath = path.posix.join('resumes', application.id, `${uploadId}.pdf`);
      const servedUrl = `/api/resume-uploads/${uploadId}/file`;

      await putResume(relativePath, req.file.buffer);
      writtenPath = relativePath;

      const existing = await versionRows(application.id);
      const now = new Date();

      await prisma.$transaction([
        // First replacement: capture the resume being replaced, so the file a
        // reviewer scored stays reachable even though it lives in Drive.
        ...(existing.length === 0 && application.resumeUrl
          ? [
              prisma.resumeUpload.create({
                data: {
                  applicationId: application.id,
                  storagePath: null,
                  sourceUrl: application.resumeUrl,
                  uploadedAt: application.submittedAt,
                  supersededAt: now,
                },
              }),
            ]
          : []),
        prisma.resumeUpload.updateMany({
          where: { applicationId: application.id, supersededAt: null },
          data: { supersededAt: now },
        }),
        prisma.resumeUpload.create({
          data: {
            id: uploadId,
            applicationId: application.id,
            storagePath: relativePath,
            sourceUrl: servedUrl,
            originalName: req.file.originalname || null,
            sizeBytes: req.file.size,
            uploadedById: req.user.id,
            uploadedAt: now,
          },
        }),
        prisma.application.update({
          where: { id: application.id },
          data: {
            resumeUrl: servedUrl,
            // The anonymized copy was derived from the resume just replaced.
            blindResumeUrl: null,
          },
        }),
      ]);

      const rows = await versionRows(application.id);
      res.status(201).json({
        message: 'Your resume has been updated.',
        currentResumeUrl: servedUrl,
        versions: buildVersions({ ...application, resumeUrl: servedUrl }, rows),
      });
    } catch (error) {
      // Don't leave an orphaned file behind if the database write failed.
      if (writtenPath) await removeResume(writtenPath).catch(() => {});
      console.error('[POST /api/resume-uploads/applications/:applicationId]', error);
      res.status(500).json({ error: 'Failed to upload resume' });
    }
  }
);

// GET /api/resume-uploads/:uploadId/file
// The only way a stored replacement resume is served. Applicant or staff.
router.get('/:uploadId/file', requireAuth, async (req, res) => {
  try {
    const upload = await prisma.resumeUpload.findUnique({
      where: { id: req.params.uploadId },
      select: {
        storagePath: true,
        originalName: true,
        application: { select: applicationWithOwnership },
      },
    });

    if (!upload || !upload.storagePath) return res.status(404).json({ error: 'Resume not found' });
    if (!isOwnedBy(upload.application, req.user) && !isStaff(req.user)) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    // Defensive: the path comes from the database, but a traversal in it would
    // otherwise hand out arbitrary files.
    if (!upload.storagePath.startsWith('resumes/')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const buffer = await getResume(upload.storagePath);
    if (!buffer) {
      return res.status(404).json({ error: 'Resume file not found' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.send(buffer);
  } catch (error) {
    console.error('[GET /api/resume-uploads/:uploadId/file]', error);
    res.status(500).json({ error: 'Failed to serve resume' });
  }
});

// Multer rejects oversized files and non-PDFs before any handler runs; without
// this they surface as a generic 500.
router.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        error: `Your resume must be smaller than ${Math.round(MAX_RESUME_BYTES / (1024 * 1024))}MB`,
      });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) return res.status(400).json({ error: err.message || 'Upload failed' });
  next();
});

export default router;
