// The two rules that make the external talent portal safe to expose publicly:
// only a UCLA address may register, and consent is only ever an explicit yes.
import { describe, it, expect } from 'vitest';
import {
  isUclaEmail,
  normalizeEmail,
  sanitizeExternalSignup,
  sanitizeExternalResumeInput,
  serializeExternalResume,
  createVerificationToken,
  VERIFICATION_TTL_MS,
  MIN_PASSWORD_LENGTH
} from './externalTalent.js';

describe('isUclaEmail', () => {
  it('accepts the addresses UCLA actually issues', () => {
    expect(isUclaEmail('bruin@ucla.edu')).toBe(true);
    expect(isUclaEmail('bruin@g.ucla.edu')).toBe(true);
    expect(isUclaEmail('bruin@anderson.ucla.edu')).toBe(true);
    expect(isUclaEmail('  bruin@G.UCLA.EDU  ')).toBe(true);
  });

  it('rejects a lookalike domain that merely ends in the right letters', () => {
    // The suffix check this pattern replaces would pass both of these.
    expect(isUclaEmail('bruin@notucla.edu')).toBe(false);
    expect(isUclaEmail('bruin@ucla.edu.attacker.com')).toBe(false);
  });

  it('rejects a personal address, the most common signup mistake', () => {
    expect(isUclaEmail('bruin@gmail.com')).toBe(false);
  });

  it('rejects non-strings without throwing', () => {
    expect(isUclaEmail(null)).toBe(false);
    expect(isUclaEmail(undefined)).toBe(false);
    expect(isUclaEmail(42)).toBe(false);
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims, so one mailbox cannot become two accounts', () => {
    expect(normalizeEmail('  Bruin@G.UCLA.edu ')).toBe('bruin@g.ucla.edu');
  });

  it('returns empty string for a non-string', () => {
    expect(normalizeEmail(null)).toBe('');
  });
});

describe('sanitizeExternalSignup', () => {
  const valid = {
    fullName: '  Joski Bruin ',
    email: 'Joski@G.UCLA.edu',
    password: 'a-long-enough-password',
    graduationYear: '2027'
  };

  it('normalizes a valid signup', () => {
    const { value, errors } = sanitizeExternalSignup(valid);
    expect(errors).toEqual([]);
    expect(value.fullName).toBe('Joski Bruin');
    expect(value.email).toBe('joski@g.ucla.edu');
    expect(value.graduationYear).toBe('2027');
  });

  it('names the accepted domains rather than saying "invalid email"', () => {
    const { errors } = sanitizeExternalSignup({ ...valid, email: 'joski@gmail.com' });
    expect(errors.some((e) => /ucla\.edu/.test(e))).toBe(true);
  });

  it('rejects a short password', () => {
    const { errors } = sanitizeExternalSignup({ ...valid, password: 'x'.repeat(MIN_PASSWORD_LENGTH - 1) });
    expect(errors.some((e) => /at least/.test(e))).toBe(true);
  });

  it('requires a four-digit graduation year, not free text', () => {
    // The whole point of collecting it here is that it filters alike with
    // Application.graduationYear, which is "2029" and never "Spring 2029".
    for (const bad of ['Spring 2027', '27', '', '20277']) {
      const { errors } = sanitizeExternalSignup({ ...valid, graduationYear: bad });
      expect(errors.some((e) => /four digits/.test(e))).toBe(true);
    }
  });

  it('reports every problem at once rather than one per round trip', () => {
    const { errors } = sanitizeExternalSignup({});
    expect(errors.length).toBeGreaterThan(2);
  });
});

describe('sanitizeExternalResumeInput', () => {
  it('treats anything but an explicit yes as no consent', () => {
    for (const value of [undefined, null, '', 'false', false, 'yes', 1, {}]) {
      const { value: parsed } = sanitizeExternalResumeInput({
        major1: 'Economics',
        graduationYear: '2027',
        shareConsent: value
      });
      expect(parsed.shareConsent).toBe(false);
    }
  });

  it('accepts an explicit yes in either the boolean or form-encoded shape', () => {
    expect(
      sanitizeExternalResumeInput({ major1: 'Economics', graduationYear: '2027', shareConsent: true })
        .value.shareConsent
    ).toBe(true);
    // multipart/form-data has no booleans - everything arrives as a string.
    expect(
      sanitizeExternalResumeInput({ major1: 'Economics', graduationYear: '2027', shareConsent: 'true' })
        .value.shareConsent
    ).toBe(true);
  });

  it('requires a major', () => {
    const { errors } = sanitizeExternalResumeInput({ major1: '   ', graduationYear: '2027' });
    expect(errors.some((e) => /major/i.test(e))).toBe(true);
  });

  it('stores an unspecified gender as null rather than a value nobody filters on', () => {
    const { value } = sanitizeExternalResumeInput({ major1: 'Economics', graduationYear: '2027' });
    expect(value.gender).toBeNull();
  });
});

describe('createVerificationToken', () => {
  it('mints a distinct token each call', () => {
    expect(createVerificationToken().token).not.toBe(createVerificationToken().token);
  });

  it('expires the configured TTL after the given moment', () => {
    const now = new Date('2026-08-26T12:00:00.000Z');
    const { expiresAt } = createVerificationToken(now);
    expect(expiresAt.getTime() - now.getTime()).toBe(VERIFICATION_TTL_MS);
  });
});

describe('serializeExternalResume', () => {
  const row = {
    id: 'er-1',
    userId: 'user-1',
    isCurrent: true,
    storagePath: 'external-resumes/er-1/resume.pdf',
    originalName: 'resume.pdf',
    fileSize: 2048,
    major1: 'Economics',
    major2: null,
    graduationYear: '2027',
    gender: 'Other',
    shareConsent: true,
    consentAt: new Date('2026-08-20'),
    consentRevokedAt: null,
    createdAt: new Date('2026-08-20'),
    updatedAt: new Date('2026-08-21')
  };

  it('never emits storagePath', () => {
    // The owner reads their own file through the endpoint, never by path.
    const dto = serializeExternalResume(row, 2);
    expect(dto).not.toHaveProperty('storagePath');
    expect(dto).not.toHaveProperty('userId');
  });

  it('carries the live assignment count so the owner can see where it went', () => {
    expect(serializeExternalResume(row, 3).assignedCount).toBe(3);
  });

  it('returns null for a missing resume', () => {
    expect(serializeExternalResume(null)).toBeNull();
  });
});
