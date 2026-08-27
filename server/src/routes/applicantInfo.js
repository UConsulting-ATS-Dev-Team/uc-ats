import express from 'express';
import prisma from '../prismaClient.js';
import { requireAuth } from '../middleware/auth.js';
import { isOwnedBy } from '../utils/applicationOwnership.js';

const router = express.Router();

// Candidate self-service editing of the details they submitted on the
// application form.
//
// `email` and `studentId` are deliberately NOT editable. They are the two keys
// isOwnedBy() matches on, so a candidate who could change them could point their
// account at somebody else's application. Admins change those through
// EditCandidateModal, where the change is a deliberate staff action.
//
// Documents are not handled here either — the resume has its own versioned
// endpoint (routes/resumeUploads.js), and headshot/cover letter/video are still
// whatever the form delivered.
export const EDITABLE_FIELDS = [
  'firstName',
  'lastName',
  'phoneNumber',
  'graduationYear',
  'major1',
  'major2',
  'cumulativeGpa',
  'majorGpa',
  'isTransferStudent',
  'priorCollegeYears',
  'gender',
  'isFirstGeneration',
];

// Identity and process fields the page shows so a candidate can confirm what we
// have, but cannot change.
const READ_ONLY_FIELDS = ['id', 'email', 'studentId', 'status', 'currentRound', 'submittedAt'];

const applicationSelect = {
  ...Object.fromEntries([...EDITABLE_FIELDS, ...READ_ONLY_FIELDS].map((field) => [field, true])),
  candidate: { select: { email: true, studentId: true } },
  cycle: { select: { id: true, name: true, isActive: true } },
};

class ValidationError extends Error {}

const text = (max, { required }) => (value, label) => {
  if (value === null || value === undefined || String(value).trim() === '') {
    if (required) throw new ValidationError(`${label} is required.`);
    return null;
  }
  const trimmed = String(value).trim();
  if (trimmed.length > max) throw new ValidationError(`${label} must be ${max} characters or fewer.`);
  return trimmed;
};

const bool = (value, label) => {
  if (typeof value === 'boolean') return value;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ValidationError(`${label} must be yes or no.`);
};

// GPAs are Decimal(3, 2), so anything at or above 10 does not fit the column at
// all. The 0–5 bound is the useful check: it catches a percentage typed into a
// GPA box while still allowing the weighted scales that run past 4.0.
const gpa = ({ required }) => (value, label) => {
  if (value === null || value === undefined || String(value).trim() === '') {
    if (required) throw new ValidationError(`${label} is required.`);
    return null;
  }
  const parsed = Number(String(value).trim());
  if (!Number.isFinite(parsed)) throw new ValidationError(`${label} must be a number.`);
  if (parsed < 0 || parsed > 5) throw new ValidationError(`${label} must be between 0.00 and 5.00.`);
  return Math.round(parsed * 100) / 100;
};

const VALIDATORS = {
  firstName: text(100, { required: true }),
  lastName: text(100, { required: true }),
  phoneNumber: text(40, { required: true }),
  graduationYear: text(10, { required: true }),
  major1: text(100, { required: true }),
  major2: text(100, { required: false }),
  cumulativeGpa: gpa({ required: true }),
  majorGpa: gpa({ required: false }),
  isTransferStudent: bool,
  priorCollegeYears: text(50, { required: false }),
  gender: text(50, { required: false }),
  isFirstGeneration: bool,
};

const LABELS = {
  firstName: 'First name',
  lastName: 'Last name',
  phoneNumber: 'Phone number',
  graduationYear: 'Graduation year',
  major1: 'Primary major',
  major2: 'Second major',
  cumulativeGpa: 'Cumulative GPA',
  majorGpa: 'Major GPA',
  isTransferStudent: 'Transfer student',
  priorCollegeYears: 'Prior college years',
  gender: 'Gender',
  isFirstGeneration: 'First-generation student',
};

// Decimal columns come back as Prisma Decimal objects, which serialize to JSON
// as an object rather than a number; the form needs a plain value to put in an
// input.
function serialize(application) {
  return {
    ...application,
    cumulativeGpa: application.cumulativeGpa === null ? null : Number(application.cumulativeGpa),
    majorGpa: application.majorGpa === null ? null : Number(application.majorGpa),
    editableFields: EDITABLE_FIELDS,
  };
}

async function loadOwned(req, res) {
  const application = await prisma.application.findUnique({
    where: { id: req.params.applicationId },
    select: applicationSelect,
  });

  if (!application) {
    res.status(404).json({ error: 'Application not found' });
    return null;
  }
  // Staff are not given an exception here: this endpoint exists so a candidate
  // can correct their own record, and admin edits belong on the admin surface.
  if (!isOwnedBy(application, req.user)) {
    res.status(403).json({ error: 'Only the applicant can update this information.' });
    return null;
  }
  return application;
}

// GET /api/applicant-info/applications/:applicationId
router.get('/applications/:applicationId', requireAuth, async (req, res) => {
  try {
    const application = await loadOwned(req, res);
    if (!application) return;
    res.json(serialize(application));
  } catch (error) {
    console.error('[GET /api/applicant-info/applications/:applicationId]', error);
    res.status(500).json({ error: 'Failed to load your information' });
  }
});

// PATCH /api/applicant-info/applications/:applicationId
// Accepts any subset of EDITABLE_FIELDS. Unknown keys are ignored rather than
// rejected so that a field added to the form later cannot be smuggled through
// this endpoint before anyone has decided it is candidate-editable.
router.patch('/applications/:applicationId', requireAuth, async (req, res) => {
  try {
    const application = await loadOwned(req, res);
    if (!application) return;

    const data = {};
    for (const field of EDITABLE_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(req.body || {}, field)) continue;
      data[field] = VALIDATORS[field](req.body[field], LABELS[field]);
    }

    if (Object.keys(data).length === 0) {
      return res.status(400).json({ error: 'No changes were submitted.' });
    }

    // A transfer student who says they are no longer one should not keep a
    // stale "prior college years" answer hanging off the record.
    if (data.isTransferStudent === false) data.priorCollegeYears = null;

    const updated = await prisma.application.update({
      where: { id: application.id },
      data,
      select: applicationSelect,
    });

    res.json({ message: 'Your information has been updated.', application: serialize(updated) });
  } catch (error) {
    if (error instanceof ValidationError) return res.status(400).json({ error: error.message });
    console.error('[PATCH /api/applicant-info/applications/:applicationId]', error);
    res.status(500).json({ error: 'Failed to update your information' });
  }
});

export default router;
