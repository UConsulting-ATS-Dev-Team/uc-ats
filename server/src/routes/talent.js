// The external talent portal: everything a self-registered UCLA student can do.
//
// The account is role USER, the same role an applicant tracking an application
// has, distinguished by User.isExternalTalent. Every route here gates on that
// flag as well as the role, so an applicant who wanders onto /api/talent/* gets
// a 403 rather than a second, parallel resume that no admin screen would ever
// show them.
//
// The gate that matters is emailVerifiedAt. A member is vouched for by having
// been recruited and an applicant by having submitted an application; a stranger
// who found this page is vouched for by nothing but a verified ucla.edu address.
// So nothing that could reach a partner - the upload, and the consent that makes
// it assignable - is reachable before that address is proved.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import prisma from '../prismaClient.js';
import { putResume, getResume } from '../services/resumeStorage.js';
import { requireAuth, invalidateUserCache } from '../middleware/auth.js';
import {
  EXTERNAL_GENDERS,
  FULL_NAME_MAX_LENGTH,
  sanitizeExternalResumeInput,
  serializeExternalResume
} from '../utils/externalTalent.js';

const router = express.Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// In memory so the file can be named by the DB-generated row id, matching the
// reasoning in member.js and cases.js.
const resumeUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    if (file.mimetype === 'application/pdf') cb(null, true);
    else cb(new Error('Resume must be a PDF'));
  }
});

// There is no global Express error handler in this app, so an unwrapped multer
// rejection returns an HTML 500 that the client renders as
// "Server Error (500): <!doctype html...". Same wrapper as member.js.
function resumeUploadMiddleware(req, res, next) {
  resumeUpload.single('resume')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ error: 'Resume must be 10MB or smaller' });
      }
      return res.status(400).json({ error: err.message });
    }
    return res.status(400).json({ error: err.message || 'Invalid file upload' });
  });
}

const requireExternalTalent = (req, res, next) => {
  if (req.user?.role !== 'USER' || req.user?.isExternalTalent !== true) {
    return res.status(403).json({ error: 'Talent portal access required' });
  }
  next();
};

// Split from requireExternalTalent so the profile is readable and editable while
// unverified - the portal has to be able to render the "check your email" state
// and let someone fix a typo in their name before the link arrives.
const requireVerifiedEmail = (req, res, next) => {
  if (!req.user?.emailVerifiedAt) {
    return res.status(403).json({
      error: 'Verify your UCLA email before uploading a resume.',
      needsVerification: true
    });
  }
  next();
};

router.use(requireAuth, requireExternalTalent);

const loadOwnResume = (userId) =>
  prisma.externalResume.findFirst({ where: { userId, isCurrent: true } });

const countLiveAssignments = (resumeId) =>
  resumeId
    ? prisma.clientResumeAssignment.count({
        where: { externalResumeId: resumeId, revokedAt: null }
      })
    : Promise.resolve(0);

const YEAR_PATTERN = /^(19|20)\d{2}$/;

router.get('/me', async (req, res) => {
  try {
    const resume = await loadOwnResume(req.user.id);
    const assignedCount = await countLiveAssignments(resume?.id);

    res.json({
      profile: {
        fullName: req.user.fullName,
        email: req.user.email,
        // Stored as four bare digits by the signup sanitizer, so the resume
        // form can prefill from it directly.
        graduationYear: req.user.graduationClass || '',
        emailVerified: Boolean(req.user.emailVerifiedAt),
        emailVerifiedAt: req.user.emailVerifiedAt
      },
      resume: serializeExternalResume(resume, assignedCount),
      genders: EXTERNAL_GENDERS
    });
  } catch (error) {
    console.error('[GET /api/talent/me]', error);
    res.status(500).json({ error: 'Failed to load your profile' });
  }
});

router.patch('/profile', async (req, res) => {
  try {
    const fullName =
      typeof req.body?.fullName === 'string'
        ? req.body.fullName.trim().slice(0, FULL_NAME_MAX_LENGTH)
        : '';
    // Bounded above four on purpose - see sanitizeExternalSignup. Slicing to 4
    // first would let "20277" through as "2027".
    const graduationYear =
      typeof req.body?.graduationYear === 'string' ? req.body.graduationYear.trim().slice(0, 16) : '';

    const errors = [];
    if (!fullName) errors.push('Enter your full name.');
    if (!YEAR_PATTERN.test(graduationYear)) {
      errors.push('Enter your graduation year as four digits, for example 2027.');
    }
    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], errors });
    }

    const user = await prisma.user.update({
      where: { id: req.user.id },
      data: { fullName, graduationClass: graduationYear }
    });

    // The name a partner sees on an already-assigned resume is read live off
    // this row (see projectAssignment), so a stale cache would show the old one
    // to the owner while showing the new one to the buyer.
    invalidateUserCache(user.id);

    res.json({
      profile: {
        fullName: user.fullName,
        email: user.email,
        graduationYear: user.graduationClass || '',
        emailVerified: Boolean(user.emailVerifiedAt),
        emailVerifiedAt: user.emailVerifiedAt
      }
    });
  } catch (error) {
    console.error('[PATCH /api/talent/profile]', error);
    res.status(500).json({ error: 'Failed to update your profile' });
  }
});

router.post('/resume', requireVerifiedEmail, resumeUploadMiddleware, async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Attach a PDF resume' });
    }

    const { value, errors } = sanitizeExternalResumeInput(req.body || {});
    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], errors });
    }

    // Re-uploading supersedes rather than overwrites, exactly as it does for a
    // member: an assignment already committed to a client keeps pointing at the
    // exact file that was assigned.
    const created = await prisma.$transaction(async (tx) => {
      await tx.externalResume.updateMany({
        where: { userId: req.user.id, isCurrent: true },
        data: { isCurrent: false }
      });
      return tx.externalResume.create({
        data: {
          userId: req.user.id,
          isCurrent: true,
          storagePath: 'pending',
          originalName: req.file.originalname ? req.file.originalname.slice(0, 255) : 'resume.pdf',
          fileSize: req.file.size,
          major1: value.major1,
          major2: value.major2,
          graduationYear: value.graduationYear,
          gender: value.gender,
          shareConsent: value.shareConsent,
          consentAt: value.shareConsent ? new Date() : null
        }
      });
    });

    const relPath = `external-resumes/${created.id}/resume.pdf`;
    try {
      await putResume(relPath, req.file.buffer);
    } catch (writeError) {
      // Leaving a row pointing at a file that does not exist would make the
      // resume look uploaded and then 404 for whoever opens it.
      await prisma.externalResume.delete({ where: { id: created.id } }).catch(() => {});
      throw writeError;
    }

    const resume = await prisma.externalResume.update({
      where: { id: created.id },
      data: { storagePath: relPath }
    });

    res.status(201).json({ resume: serializeExternalResume(resume, 0) });
  } catch (error) {
    console.error('[POST /api/talent/resume]', error);
    res.status(500).json({ error: 'Failed to upload your resume' });
  }
});

router.patch('/resume/consent', requireVerifiedEmail, async (req, res) => {
  try {
    const shareConsent = req.body?.shareConsent === true || req.body?.shareConsent === 'true';

    const existing = await loadOwnResume(req.user.id);
    if (!existing) {
      return res.status(404).json({ error: 'Upload a resume first' });
    }

    const now = new Date();

    const resume = await prisma.$transaction(async (tx) => {
      const updated = await tx.externalResume.update({
        where: { id: existing.id },
        data: {
          shareConsent,
          consentAt: shareConsent ? now : existing.consentAt,
          consentRevokedAt: shareConsent ? null : now
        }
      });

      if (!shareConsent) {
        // Withdrawal takes effect immediately rather than waiting for an admin
        // to notice. This is the one place the snapshot rule yields, and it
        // yields to the person whose resume it is.
        await tx.clientResumeAssignment.updateMany({
          where: { externalResumeId: existing.id, revokedAt: null },
          data: { revokedAt: now, revokedById: req.user.id }
        });
      }

      return updated;
    });

    const assignedCount = await countLiveAssignments(resume.id);
    res.json({ resume: serializeExternalResume(resume, assignedCount) });
  } catch (error) {
    console.error('[PATCH /api/talent/resume/consent]', error);
    res.status(500).json({ error: 'Failed to update your sharing preference' });
  }
});

router.get('/resume/pdf', async (req, res) => {
  try {
    const resume = await loadOwnResume(req.user.id);
    if (!resume) return res.status(404).json({ error: 'No resume on file' });

    if (!resume.storagePath.startsWith('external-resumes/')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    const buffer = await getResume(resume.storagePath);
    if (!buffer) {
      return res.status(404).json({ error: 'Your resume file could not be found. Please upload it again.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(buffer);
  } catch (error) {
    console.error('[GET /api/talent/resume/pdf]', error);
    res.status(500).json({ error: 'Failed to load your resume' });
  }
});

router.delete('/resume', async (req, res) => {
  try {
    const existing = await loadOwnResume(req.user.id);
    if (!existing) return res.status(404).json({ error: 'No resume on file' });

    const now = new Date();

    await prisma.$transaction(async (tx) => {
      await tx.externalResume.update({
        where: { id: existing.id },
        data: { isCurrent: false, shareConsent: false, consentRevokedAt: now }
      });
      await tx.clientResumeAssignment.updateMany({
        where: { externalResumeId: existing.id, revokedAt: null },
        data: { revokedAt: now, revokedById: req.user.id }
      });
    });

    // The file stays on disk on purpose: revoked assignment rows still reference
    // this resume, and the history is worth more than a few hundred KB.
    res.json({ ok: true });
  } catch (error) {
    console.error('[DELETE /api/talent/resume]', error);
    res.status(500).json({ error: 'Failed to remove your resume' });
  }
});

export default router;
