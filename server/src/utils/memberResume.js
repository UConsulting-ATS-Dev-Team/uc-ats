// Validation for a member-uploaded resume. Pure, in the style of
// utils/gtkucProfile.js, so the route stays thin and the rules are testable.

// Same vocabulary the application form produces, so the two pools filter alike.
// "Prefer not to say" is stored as null rather than as a value nobody filters on.
export const MEMBER_GENDERS = ['Male', 'Female', 'Other'];

export const MAJOR_MAX_LENGTH = 120;

// Application.graduationYear is a 4-digit string ("2029"). User.graduationClass
// is free text ("Spring 2027"), which is why this is collected fresh at upload
// rather than derived - the two would not filter alike.
const YEAR_PATTERN = /^(19|20)\d{2}$/;

const trimmed = (value, max) => {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, max);
};

/**
 * Normalize and validate the metadata that accompanies a resume upload.
 * Returns { value, errors }.
 */
export const sanitizeMemberResumeInput = (input = {}) => {
  const errors = [];

  const major1 = trimmed(input.major1, MAJOR_MAX_LENGTH);
  const major2 = trimmed(input.major2, MAJOR_MAX_LENGTH);
  const graduationYear = trimmed(input.graduationYear, 4);
  const genderRaw = trimmed(input.gender, 40);

  if (!major1) {
    errors.push('Enter your major.');
  }

  if (!YEAR_PATTERN.test(graduationYear)) {
    errors.push('Enter your graduation year as four digits, for example 2027.');
  }

  let gender = null;
  if (genderRaw) {
    const match = MEMBER_GENDERS.find((g) => g.toLowerCase() === genderRaw.toLowerCase());
    if (!match) {
      errors.push(`Gender must be one of: ${MEMBER_GENDERS.join(', ')}.`);
    } else {
      gender = match;
    }
  }

  // Consent is only ever true when explicitly and unambiguously given.
  // A missing or unparseable value means no.
  const shareConsent = input.shareConsent === true || input.shareConsent === 'true';

  return {
    value: {
      major1,
      major2: major2 || null,
      graduationYear,
      gender,
      shareConsent
    },
    errors
  };
};

/**
 * The row shape the member portal renders. Deliberately excludes storagePath -
 * the member reads their own file through the endpoint, not by path.
 */
export const serializeMemberResume = (resume, assignedCount = 0) => {
  if (!resume) return null;
  return {
    id: resume.id,
    originalName: resume.originalName,
    fileSize: resume.fileSize,
    major1: resume.major1,
    major2: resume.major2,
    graduationYear: resume.graduationYear,
    gender: resume.gender,
    shareConsent: resume.shareConsent,
    consentAt: resume.consentAt,
    consentRevokedAt: resume.consentRevokedAt,
    uploadedAt: resume.createdAt,
    updatedAt: resume.updatedAt,
    // So a member can see that their resume is actually out with partners.
    assignedCount
  };
};
