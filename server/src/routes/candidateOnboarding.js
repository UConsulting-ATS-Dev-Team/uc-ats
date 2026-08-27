// Onboarding for a candidate account with nothing behind it.
//
// Someone who signs up at /signup gets a User and a Candidate row and nothing
// else. If they have applied before, the Google Forms sync has already filed an
// Application against their student ID or email and every candidate screen has
// something to show them. If they have not, those screens are empty and we know
// nothing about them beyond a name and an address - so this collects the
// applicant information an application would have carried.
//
// A resume is the only file asked for. No cover letter and no video: those are
// cycle deliverables, judged by a review team against a rubric, and collecting
// them outside a cycle would produce documents nobody is assigned to score. A
// headshot is accepted but optional.
//
// The module also asks whether the resume may go to Talent Partner Network
// companies. Saying yes writes an ExternalResume, which is the row the TPN pool
// is built from - the pool gates on consent and a verified email, not on
// isExternalTalent, so a candidate's resume joins it on exactly the same terms
// as a self-registered student's, and every admin and client screen picks it up
// with no change. Saying no revokes any consent already given, immediately.
//
// The gate is emailVerifiedAt, matching routes/talent.js. Reading the status is
// open so the app can render the "check your email" state; submitting is not.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import multer from 'multer';
import prisma from '../prismaClient.js';
import { putResume, getResume } from '../services/resumeStorage.js';
import { requireAuth } from '../middleware/auth.js';
import { sanitizeOnboardingInput, serializeOnboarding } from '../utils/candidateOnboarding.js';

const router = express.Router();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MAX_RESUME_BYTES = 10 * 1024 * 1024;
const MAX_HEADSHOT_BYTES = 5 * 1024 * 1024;
const HEADSHOT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

// In memory so each file can be named by the DB-generated row id, matching
// talent.js. The limit is the larger of the two; the per-field check below is
// what actually enforces the headshot's smaller ceiling.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_RESUME_BYTES },
  fileFilter(req, file, cb) {
    if (file.fieldname === 'resume') {
      if (file.mimetype === 'application/pdf') return cb(null, true);
      return cb(new Error('Resume must be a PDF'));
    }
    if (file.fieldname === 'headshot') {
      if (HEADSHOT_TYPES.has(file.mimetype)) return cb(null, true);
      return cb(new Error('Headshot must be a JPEG, PNG or WebP image'));
    }
    return cb(new Error('Unexpected file field'));
  }
});

// There is no global Express error handler in this app, so an unwrapped multer
// rejection returns an HTML 500 that the client renders as
// "Server Error (500): <!doctype html...". Same wrapper as talent.js.
function uploadMiddleware(req, res, next) {
  upload.fields([
    { name: 'resume', maxCount: 1 },
    { name: 'headshot', maxCount: 1 }
  ])(req, res, (err) => {
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

// An external talent account is role USER too, but it has no Candidate row and
// its own portal. Without this it would fall through to a 404 on the candidate
// lookup below, which reads as a bug rather than as "wrong door".
const requireCandidate = (req, res, next) => {
  if (req.user?.role !== 'USER' || req.user?.isExternalTalent === true) {
    return res.status(403).json({ error: 'Candidate access required' });
  }
  next();
};

const requireVerifiedEmail = (req, res, next) => {
  if (!req.user?.emailVerifiedAt) {
    return res.status(403).json({
      error: 'Verify your email before completing onboarding.',
      needsVerification: true
    });
  }
  next();
};

router.use(requireAuth, requireCandidate);

/**
 * The candidate row this account owns.
 *
 * Matched on studentId first and email second, the same order the Forms sync
 * uses in utils/dataMapper.js - a student who applied with a personal address
 * and signed up with their UCLA one is the same person, and the student ID is
 * what says so.
 */
const loadOwnCandidate = async (user) => {
  const or = [];
  if (user.studentId) or.push({ studentId: user.studentId });
  if (user.email) or.push({ email: user.email });
  if (or.length === 0) return null;
  return prisma.candidate.findFirst({
    where: { OR: or },
    include: { onboarding: true, applications: { select: { id: true }, take: 1 } }
  });
};

/**
 * GET /api/candidate/onboarding/status
 *
 * Whether this account needs to be taken through the module, and what it has
 * already answered. `required` is the whole point: it is false the moment an
 * application exists, because an application carries everything this collects
 * and asking again would be asking a question we can already answer.
 */
router.get('/status', async (req, res) => {
  try {
    const candidate = await loadOwnCandidate(req.user);

    if (!candidate) {
      // Signup creates the Candidate row, so this is a data problem rather than
      // a normal state. Reporting it as "not required" would quietly strand the
      // account with no profile and no prompt to build one.
      return res.status(404).json({ error: 'No candidate record for this account' });
    }

    const hasApplication = candidate.applications.length > 0;
    const completed = Boolean(candidate.onboarding);

    const pooled = await prisma.externalResume.findFirst({
      where: { userId: req.user.id, isCurrent: true }
    });

    res.json({
      required: !hasApplication && !completed,
      hasApplication,
      completed,
      emailVerified: Boolean(req.user.emailVerifiedAt),
      onboarding: serializeOnboarding(candidate.onboarding),
      // So the module can show what was chosen last time, and the dashboard can
      // offer a way to change it without re-uploading anything.
      talentPool: {
        shared: Boolean(pooled?.shareConsent),
        consentAt: pooled?.consentAt ?? null,
        consentRevokedAt: pooled?.consentRevokedAt ?? null
      }
    });
  } catch (error) {
    console.error('[GET /api/candidate/onboarding/status]', error);
    res.status(500).json({ error: 'Failed to load your onboarding status' });
  }
});

/**
 * Put this candidate's resume into - or pull it out of - the Talent Partner
 * Network pool.
 *
 * Opting in writes a *separate copy* under external-resumes/ rather than
 * pointing at the onboarding file. That looks like duplication and is not: an
 * onboarding resubmission overwrites its own resume in place, so a shared path
 * would silently change the bytes underneath an assignment a client has already
 * been given. Superseding copies are what keep "the client sees the exact file
 * that was assigned" true, and it is the same reason routes/talent.js supersedes
 * instead of overwriting.
 *
 * A send-nothing no-op when the answer is no and there was never a resume.
 */
const applyTalentPoolConsent = async ({ user, optIn, resumeFile, metadata }) => {
  const current = await prisma.externalResume.findFirst({
    where: { userId: user.id, isCurrent: true }
  });

  if (!optIn) {
    if (!current || !current.shareConsent) {
      return { shared: false };
    }
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      await tx.externalResume.update({
        where: { id: current.id },
        data: { shareConsent: false, consentRevokedAt: now }
      });
      // Withdrawal takes effect immediately rather than waiting for an admin to
      // notice, matching PATCH /api/talent/resume/consent. This is the one place
      // the snapshot rule yields, and it yields to the person whose resume it is.
      await tx.clientResumeAssignment.updateMany({
        where: { externalResumeId: current.id, revokedAt: null },
        data: { revokedAt: now, revokedById: user.id }
      });
    });
    return { shared: false, revoked: true };
  }

  const created = await prisma.$transaction(async (tx) => {
    await tx.externalResume.updateMany({
      where: { userId: user.id, isCurrent: true },
      data: { isCurrent: false }
    });
    return tx.externalResume.create({
      data: {
        userId: user.id,
        isCurrent: true,
        storagePath: 'pending',
        originalName: (resumeFile.originalname || 'resume.pdf').slice(0, 255),
        fileSize: resumeFile.size,
        major1: metadata.major1,
        major2: metadata.major2,
        graduationYear: metadata.graduationYear,
        gender: metadata.gender,
        shareConsent: true,
        consentAt: new Date()
      }
    });
  });

  const relPath = `external-resumes/${created.id}/resume.pdf`;
  try {
    await putResume(relPath, resumeFile.buffer);
  } catch (writeError) {
    // Leaving a row pointing at a file that does not exist would put a resume in
    // the pool that 404s for the first client who opens it.
    await prisma.externalResume.delete({ where: { id: created.id } }).catch(() => {});
    throw writeError;
  }

  await prisma.externalResume.update({
    where: { id: created.id },
    data: { storagePath: relPath }
  });

  return { shared: true, resumeId: created.id };
};

/**
 * POST /api/candidate/onboarding
 *
 * Submit the module. Re-submitting overwrites rather than superseding, unlike a
 * resume upload: nothing here has been handed to a review team or a partner, so
 * there is no committed copy that has to keep pointing at the exact old file.
 */
router.post('/', requireVerifiedEmail, uploadMiddleware, async (req, res) => {
  try {
    const resumeFile = req.files?.resume?.[0];
    const headshotFile = req.files?.headshot?.[0];

    if (!resumeFile) {
      return res.status(400).json({ error: 'Attach a PDF resume' });
    }

    if (headshotFile && headshotFile.size > MAX_HEADSHOT_BYTES) {
      return res.status(400).json({ error: 'Headshot must be 5MB or smaller' });
    }

    const { value, errors } = sanitizeOnboardingInput(req.body || {});
    if (errors.length > 0) {
      return res.status(400).json({ error: errors[0], errors });
    }

    const candidate = await loadOwnCandidate(req.user);
    if (!candidate) {
      return res.status(404).json({ error: 'No candidate record for this account' });
    }

    if (candidate.applications.length > 0) {
      return res.status(409).json({
        error: 'You already have an application on file, so there is nothing to onboard.'
      });
    }

    const resumeRel = `candidate-onboarding/${candidate.id}/resume.pdf`;
    const headshotRel = headshotFile
      ? `candidate-onboarding/${candidate.id}/headshot${path.extname(headshotFile.originalname || '') || '.jpg'}`
      : null;

    // Files first, row second. The opposite order can leave a completed-looking
    // profile pointing at a resume that does not exist, and a failed write here
    // just leaves an orphan file that the next successful submit overwrites.
    await putResume(resumeRel, resumeFile.buffer);
    if (headshotFile) {
      await putResume(headshotRel, headshotFile.buffer, headshotFile.mimetype);
    }

    const data = {
      phoneNumber: value.phoneNumber,
      graduationYear: value.graduationYear,
      cumulativeGpa: value.cumulativeGpa,
      major1: value.major1,
      major2: value.major2,
      gender: value.gender,
      isTransferStudent: value.isTransferStudent,
      isFirstGeneration: value.isFirstGeneration,
      resumeStoragePath: resumeRel,
      resumeOriginalName: (resumeFile.originalname || 'resume.pdf').slice(0, 255),
      resumeFileSize: resumeFile.size
    };

    // Left untouched when no new headshot is attached, so re-submitting the
    // form to fix a typo does not silently drop a headshot uploaded earlier.
    if (headshotFile) {
      data.headshotStoragePath = headshotRel;
      data.headshotOriginalName = (headshotFile.originalname || 'headshot').slice(0, 255);
      data.headshotFileSize = headshotFile.size;
    }

    const record = await prisma.candidateOnboarding.upsert({
      where: { candidateId: candidate.id },
      create: { candidateId: candidate.id, ...data },
      update: data
    });

    const talentPool = await applyTalentPoolConsent({
      user: req.user,
      optIn: value.talentPoolOptIn,
      resumeFile,
      metadata: value
    });

    res.status(201).json({ onboarding: serializeOnboarding(record), talentPool });
  } catch (error) {
    console.error('[POST /api/candidate/onboarding]', error);
    res.status(500).json({ error: 'Failed to save your information' });
  }
});

/**
 * PATCH /api/candidate/onboarding/talent-pool
 *
 * Change the sharing answer after the fact, without re-uploading. Turning it
 * back on needs a resume to share, which is why it refuses when there is no
 * onboarding record: there would be nothing to copy into the pool.
 */
router.patch('/talent-pool', requireVerifiedEmail, async (req, res) => {
  try {
    const optIn = req.body?.talentPoolOptIn === true || req.body?.talentPoolOptIn === 'true';

    const candidate = await loadOwnCandidate(req.user);
    const record = candidate?.onboarding;
    if (!record) {
      return res.status(404).json({ error: 'Complete onboarding first' });
    }

    // Re-opting-in re-reads the stored resume rather than asking for it again,
    // so the pooled copy is the file this person actually submitted.
    const buffer = optIn
      ? await getResume(record.resumeStoragePath)
      : null;

    const talentPool = await applyTalentPoolConsent({
      user: req.user,
      optIn,
      resumeFile: buffer
        ? { buffer, originalname: record.resumeOriginalName, size: record.resumeFileSize }
        : null,
      metadata: record
    });

    res.json({ talentPool });
  } catch (error) {
    console.error('[PATCH /api/candidate/onboarding/talent-pool]', error);
    res.status(500).json({ error: 'Failed to update your sharing preference' });
  }
});

/**
 * GET /api/candidate/onboarding/resume
 *
 * The candidate reading back their own resume. Streamed through the route
 * rather than served by path, for the same reason talent.js does it: the
 * storage root is not public and must not become so.
 */
router.get('/resume', async (req, res) => {
  try {
    const candidate = await loadOwnCandidate(req.user);
    const record = candidate?.onboarding;
    if (!record) {
      return res.status(404).json({ error: 'No resume on file' });
    }

    const buffer = await getResume(record.resumeStoragePath);
    if (!buffer) {
      return res.status(404).json({ error: 'Your resume file could not be found. Please upload it again.' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(record.resumeOriginalName)}"`);
    res.send(buffer);
  } catch (error) {
    console.error('[GET /api/candidate/onboarding/resume]', error);
    res.status(500).json({ error: 'Failed to load your resume' });
  }
});

export default router;
