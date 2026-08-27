// Validation and projection for the external talent portal - the public
// self-signup that lets a UCLA student put a resume into the Talent Partner
// Network without ever applying to UConsulting.
//
// Pure, in the style of utils/gtkucProfile.js and utils/memberResume.js: no
// prisma, no express, so the two rules that actually matter here - "only a UCLA
// address may register" and "consent is only ever an explicit yes" - are
// testable without a database.

import crypto from 'crypto';
import { sanitizeMemberResumeInput, MEMBER_GENDERS } from './memberResume.js';

// The same gender vocabulary the application form and member uploads produce,
// re-exported under a neutral name so the three pools filter alike. Nothing
// about it is member-specific.
export const EXTERNAL_GENDERS = MEMBER_GENDERS;

export const FULL_NAME_MAX_LENGTH = 120;
export const EMAIL_MAX_LENGTH = 254;

// There is no minimum on POST /api/auth/register, which predates this file, but
// that endpoint is reached by applicants who are already in a Google Form
// pipeline. This one is linked from a public page, so it gets a floor. Ten
// rather than the twelve partner-client accounts use: those credentials are
// handed to an outside organization with no self-service reset, and these are
// chosen by their owner, who can reset them.
export const MIN_PASSWORD_LENGTH = 10;

// A verification link is a one-shot proof of address, not a session. A day is
// long enough to survive a student ignoring it until the evening and short
// enough that a forwarded or archived email stops working.
export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

// Subdomains are deliberately allowed: undergraduates get @g.ucla.edu, staff and
// some departments get @ucla.edu, and the professional schools issue addresses
// like @anderson.ucla.edu. Anchored at both ends so "ucla.edu.attacker.com" and
// "notucla.edu" both fail - the suffix check this replaces would pass the second.
export const UCLA_EMAIL_PATTERN = /^[^\s@]+@(?:[a-z0-9-]+\.)*ucla\.edu$/i;

export const isUclaEmail = (value) =>
  typeof value === 'string' && UCLA_EMAIL_PATTERN.test(value.trim());

// Addresses are stored and compared lowercased. User.email is unique, and
// without this "Bruin@ucla.edu" and "bruin@ucla.edu" would be two accounts for
// one mailbox - and only one of them could ever be verified.
export const normalizeEmail = (value) =>
  typeof value === 'string' ? value.trim().toLowerCase().slice(0, EMAIL_MAX_LENGTH) : '';

const YEAR_PATTERN = /^(19|20)\d{2}$/;

const trimmed = (value, max) => {
  if (value === null || value === undefined) return '';
  return String(value).trim().slice(0, max);
};

/**
 * Normalize and validate a public talent-portal signup.
 *
 * Graduation year is collected here rather than at upload so the account is
 * complete before the resume form is ever shown, and stored on
 * User.graduationClass as the bare four digits - not "Spring 2027" - so it can
 * be handed to ExternalResume.graduationYear unchanged and filter alike with
 * Application.graduationYear.
 *
 * @returns {{ value: object, errors: string[] }}
 */
export const sanitizeExternalSignup = (input = {}) => {
  const errors = [];

  const fullName = trimmed(input.fullName, FULL_NAME_MAX_LENGTH);
  const email = normalizeEmail(input.email);
  const password = typeof input.password === 'string' ? input.password : '';
  // Bounded well above four so the pattern below is what rejects a bad year.
  // Slicing to 4 first would turn a typo'd "20277" into a valid-looking "2027"
  // and silently file the person in the wrong class.
  const graduationYear = trimmed(input.graduationYear, 16);

  if (!fullName) {
    errors.push('Enter your full name.');
  }

  if (!email) {
    errors.push('Enter your UCLA email address.');
  } else if (!isUclaEmail(email)) {
    // Naming the accepted domains beats "invalid email" - the most common
    // failure here is a student typing a personal Gmail address.
    errors.push('Use your UCLA email address, ending in ucla.edu.');
  }

  if (password.length < MIN_PASSWORD_LENGTH) {
    errors.push(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
  }

  if (!YEAR_PATTERN.test(graduationYear)) {
    errors.push('Enter your graduation year as four digits, for example 2027.');
  }

  return { value: { fullName, email, password, graduationYear }, errors };
};

/**
 * Metadata that accompanies an external resume upload.
 *
 * Identical rules to a member upload - same fields, same gender vocabulary,
 * same "consent is only ever an explicit yes" - so it delegates rather than
 * restating them. If the two ever need to diverge, this is the seam to widen.
 */
export const sanitizeExternalResumeInput = (input = {}) => sanitizeMemberResumeInput(input);

/**
 * A fresh verification token and its expiry. Same shape and generator as the
 * password reset token in routes/auth.js, which is deliberate: one convention
 * for "a link that proves you read this mailbox".
 */
export const createVerificationToken = (now = new Date()) => ({
  token: crypto.randomBytes(32).toString('hex'),
  expiresAt: new Date(now.getTime() + VERIFICATION_TTL_MS)
});

/**
 * The row shape the talent portal renders. Excludes storagePath for the same
 * reason serializeMemberResume does - the owner reads their own file through
 * the endpoint, never by path.
 */
export const serializeExternalResume = (resume, assignedCount = 0) => {
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
    // So a student can see that their resume is actually out with partners,
    // which is the only feedback the portal can honestly give them.
    assignedCount
  };
};
