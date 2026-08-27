// Validation for the applicant information a candidate supplies at signup when
// there is no application to read it from. Pure, in the style of
// utils/externalTalent.js and utils/memberResume.js, so the route stays thin.
//
// The vocabulary deliberately matches the Google Forms application: same gender
// options, same four-digit graduation year, same GPA precision. A candidate who
// onboards here and applies later should produce two records that agree, not
// two that merely look similar.

// Same three the application form and the resume uploads use. "Prefer not to
// say" is stored as null rather than as a value nobody filters on.
export const ONBOARDING_GENDERS = ['Male', 'Female', 'Other'];

export const MAJOR_MAX_LENGTH = 120;
export const PHONE_MAX_LENGTH = 32;

const YEAR_PATTERN = /^(19|20)\d{2}$/;

// GPA bounds. The floor is obvious; the ceiling is not.
//
// 4.00 would be wrong. Weighted high-school scales routinely run past it, and
// first-years are told on the form to enter their high-school GPA - 114 of the
// applications already on file sit above 4.30, the highest legitimate one at
// 5.32. So the ceiling has to clear a weighted scale while still catching the
// two typos that actually happen: a percentage ("95") and the 9.99 that a
// Decimal(3,2) column silently clamps garbage to. Six does both.
export const GPA_MIN = 0;
export const GPA_MAX = 6;

// One or two digits, then at most two decimal places. The column is
// Decimal(3, 2), so a third decimal cannot be stored - it would be rounded away
// silently, filing someone under a GPA they never typed. Better to say so.
const GPA_PATTERN = /^\d{1,2}(\.\d{1,2})?$/;

// North American numbers: ten digits, or eleven when the country code is
// included. Everything on file is one of those two - 396 of 400 are exactly ten
// digits - so anything else is a typo rather than a format we have to honour.
const PHONE_DIGITS = /^1?(\d{10})$/;

/**
 * Reduce a typed phone number to the ten digits that identify it.
 *
 * Punctuation is discarded rather than preserved because the stored convention
 * is bare digits: 390 of the 400 numbers already on file are unformatted, and a
 * mix of "(310) 555-0134" and "3105550134" is a column nobody can search.
 *
 * @returns {string|null} ten digits, or null when the input is not a number
 */
export const normalizePhone = (value) => {
  const digits = String(value ?? '').replace(/\D/g, '');
  const match = PHONE_DIGITS.exec(digits);
  return match ? match[1] : null;
};

/**
 * Validate a GPA and pin it to the two decimals the column stores.
 *
 * Returns the canonical string rather than a number so "3.9" and "3.90" are
 * stored identically - Prisma hands a Decimal column either happily, and the
 * difference would otherwise show up in exports and filters.
 *
 * @returns {string|null} e.g. "3.90", or null when the input is not a GPA
 */
export const normalizeGpa = (value) => {
  const raw = String(value ?? '').trim();
  if (!GPA_PATTERN.test(raw)) return null;

  const gpa = Number.parseFloat(raw);
  if (Number.isNaN(gpa) || gpa < GPA_MIN || gpa > GPA_MAX) return null;

  return gpa.toFixed(2);
};

const trimmed = (value, max) => {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, max);
};

// Multipart bodies arrive as strings, so "false" has to be false. Anything that
// is not an affirmative is not an answer - these two fields are required, and
// defaulting a blank to false would silently record every skipped question as a
// "no" rather than asking again.
const toBoolean = (value) => {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
};

/**
 * Normalize and validate an onboarding submission.
 *
 * The resume file itself is checked by the route (multer enforces PDF and size);
 * this covers only the fields that travel alongside it.
 *
 * @returns {{ value: object, errors: string[] }}
 */
export const sanitizeOnboardingInput = (input = {}) => {
  const errors = [];

  const phoneNumber = normalizePhone(trimmed(input.phoneNumber, PHONE_MAX_LENGTH));
  // Bounded well above four so YEAR_PATTERN is what rejects a bad year. Slicing
  // to 4 first would turn a typo'd "20277" into a valid-looking "2027" and file
  // the person in the wrong class with no error to notice.
  const graduationYear = trimmed(input.graduationYear, 16);
  const gpaRaw = trimmed(input.cumulativeGpa, 16);
  const major1 = trimmed(input.major1, MAJOR_MAX_LENGTH);
  const major2 = trimmed(input.major2, MAJOR_MAX_LENGTH);
  const genderRaw = trimmed(input.gender, 40);
  const isTransferStudent = toBoolean(input.isTransferStudent);
  const isFirstGeneration = toBoolean(input.isFirstGeneration);
  // Talent Partner Network opt-in. Required rather than defaulted for the same
  // reason the resume uploads treat consent as "only ever an explicit yes": a
  // blank must never become permission to show someone's resume to a company.
  const talentPoolOptIn = toBoolean(input.talentPoolOptIn);

  if (!phoneNumber) {
    errors.push('Enter a 10-digit phone number, for example 310-555-0134.');
  }

  if (!YEAR_PATTERN.test(graduationYear)) {
    errors.push('Enter your graduation year as four digits, for example 2027.');
  }

  const cumulativeGpa = normalizeGpa(gpaRaw);
  if (!cumulativeGpa) {
    // One message covering every way it can be wrong. Splitting it into "too
    // many decimals" and "out of range" would mean naming the ceiling, and 6.00
    // is an anti-typo bound rather than a real scale - saying it out loud reads
    // as an invitation.
    errors.push(
      'Enter your cumulative GPA to at most two decimal places, for example 3.85.'
    );
  }

  if (!major1) {
    errors.push('Enter your major.');
  }

  if (genderRaw && !ONBOARDING_GENDERS.includes(genderRaw)) {
    errors.push('Select a gender from the list, or leave it blank.');
  }

  if (isTransferStudent === null) {
    errors.push('Tell us whether you are a transfer student.');
  }

  if (isFirstGeneration === null) {
    errors.push('Tell us whether you are a first-generation college student.');
  }

  if (talentPoolOptIn === null) {
    errors.push('Choose whether to share your resume with our partner companies.');
  }

  return {
    value: {
      phoneNumber,
      graduationYear,
      cumulativeGpa,
      major1,
      major2: major2 || null,
      gender: genderRaw || null,
      isTransferStudent,
      isFirstGeneration,
      talentPoolOptIn
    },
    errors
  };
};

/**
 * The row shape the candidate's own screens render. Excludes both storage paths
 * for the same reason serializeExternalResume does: the owner reads their own
 * files through an endpoint, never by path.
 */
export const serializeOnboarding = (record) => {
  if (!record) return null;
  return {
    id: record.id,
    phoneNumber: record.phoneNumber,
    graduationYear: record.graduationYear,
    cumulativeGpa: record.cumulativeGpa === null || record.cumulativeGpa === undefined
      ? null
      : String(record.cumulativeGpa),
    major1: record.major1,
    major2: record.major2,
    gender: record.gender,
    isTransferStudent: record.isTransferStudent,
    isFirstGeneration: record.isFirstGeneration,
    resumeOriginalName: record.resumeOriginalName,
    resumeFileSize: record.resumeFileSize,
    hasHeadshot: Boolean(record.headshotStoragePath),
    headshotOriginalName: record.headshotOriginalName,
    completedAt: record.completedAt,
    updatedAt: record.updatedAt
  };
};

/**
 * Validate an edit to onboarding details, with no file and no consent answer.
 *
 * Split from sanitizeOnboardingInput because that one is the *submission*: it
 * requires a resume and an explicit sharing answer, both of which are already
 * settled by the time someone is correcting a typo in their major. Requiring
 * them again would mean re-uploading a PDF to fix a GPA.
 */
export const sanitizeOnboardingUpdate = (input = {}) => {
  const { value, errors } = sanitizeOnboardingInput({
    ...input,
    // Satisfies the two checks that do not apply to an edit. Neither value is
    // returned to the caller below.
    talentPoolOptIn: 'false'
  });

  const { talentPoolOptIn: _ignored, ...details } = value;
  return { value: details, errors };
};
