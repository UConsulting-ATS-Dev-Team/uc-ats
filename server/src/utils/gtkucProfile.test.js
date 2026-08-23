import { describe, it, expect } from 'vitest';
import {
  GTKUC_INDUSTRIES,
  GTKUC_INTERESTS,
  MAX_INDUSTRIES,
  INTEREST_MAX_LENGTH,
  sanitizeProfileInput,
  isProfileComplete,
  missingProfileFields,
  toCandidateCard,
  needsCycleConfirmation,
  normalizeLinkedinUrl,
} from './gtkucProfile.js';

const completeProfile = {
  industries: [GTKUC_INDUSTRIES[0]],
  interests: [GTKUC_INTERESTS[0]],
  linkedinUrl: 'https://www.linkedin.com/in/member-one',
  candidateVisible: true,
  hiddenFromGtkuc: false,
  confirmations: [],
};

const member = {
  profileImage: 'https://example.com/photo.jpg',
  graduationClass: '2027',
  gtkucProfile: completeProfile,
};

describe('sanitizeProfileInput', () => {
  it('drops industries outside the taxonomy, including company names', () => {
    const result = sanitizeProfileInput({
      industries: [GTKUC_INDUSTRIES[0], 'McKinsey & Company'],
      interests: [GTKUC_INTERESTS[0]],
      linkedinUrl: '  www.linkedin.com/in/member-one/  ',
    });

    expect(result.industries).toEqual([GTKUC_INDUSTRIES[0]]);
    expect(result.interests).toEqual([GTKUC_INTERESTS[0]]);
    expect(result.linkedinUrl).toBe('https://www.linkedin.com/in/member-one');
    expect(result.rejected).toEqual(['McKinsey & Company']);
  });

  it('keeps custom interests, tidied and length-capped', () => {
    const result = sanitizeProfileInput({
      interests: ['  Formula 1  ', 'formula 1', 'Latin\ndance', 'x'.repeat(60), '   '],
    });

    expect(result.interests).toEqual([
      'Formula 1',
      'Latin dance',
      'x'.repeat(INTEREST_MAX_LENGTH),
    ]);
    // Custom interests are allowed, so nothing here is reported as rejected.
    expect(result.rejected).toEqual([]);
  });

  it('de-duplicates and caps tag counts', () => {
    const result = sanitizeProfileInput({
      industries: [...GTKUC_INDUSTRIES, GTKUC_INDUSTRIES[0]],
      interests: [GTKUC_INTERESTS[0], GTKUC_INTERESTS[0]],
    });

    expect(result.industries).toHaveLength(MAX_INDUSTRIES);
    expect(result.interests).toEqual([GTKUC_INTERESTS[0]]);
  });

  it('defaults candidateVisible to true', () => {
    expect(sanitizeProfileInput({}).candidateVisible).toBe(true);
    expect(sanitizeProfileInput({ candidateVisible: false }).candidateVisible).toBe(false);
  });
});

describe('isProfileComplete / missingProfileFields', () => {
  it('requires tags and a photo when a user is given', () => {
    expect(isProfileComplete(completeProfile, { profileImage: 'photo.jpg' })).toBe(true);
    expect(isProfileComplete(completeProfile, { profileImage: null })).toBe(false);
    expect(isProfileComplete(null)).toBe(false);
  });

  it('lists what is still missing', () => {
    expect(missingProfileFields({ industries: [], interests: [] }, { profileImage: null })).toEqual([
      'industries',
      'interests',
      'profilePicture',
    ]);
  });
});

describe('toCandidateCard', () => {
  it('exposes only curated fields', () => {
    expect(toCandidateCard(member)).toEqual({
      photo: 'https://example.com/photo.jpg',
      graduationClass: '2027',
      industries: completeProfile.industries,
      interests: completeProfile.interests,
      linkedinUrl: completeProfile.linkedinUrl,
    });
  });

  it('returns null when hidden, opted out, or incomplete', () => {
    expect(toCandidateCard({ ...member, gtkucProfile: { ...completeProfile, hiddenFromGtkuc: true } })).toBeNull();
    expect(toCandidateCard({ ...member, gtkucProfile: { ...completeProfile, candidateVisible: false } })).toBeNull();
    expect(toCandidateCard({ ...member, gtkucProfile: { ...completeProfile, interests: [] } })).toBeNull();
    expect(toCandidateCard({ profileImage: 'photo.jpg' })).toBeNull();
  });
});

describe('normalizeLinkedinUrl', () => {
  it('canonicalizes the shapes members actually paste', () => {
    const expected = 'https://www.linkedin.com/in/member-one';
    expect(normalizeLinkedinUrl('https://www.linkedin.com/in/member-one/')).toBe(expected);
    expect(normalizeLinkedinUrl('linkedin.com/in/member-one')).toBe(expected);
    expect(normalizeLinkedinUrl('http://LinkedIn.com/in/member-one?trk=nav')).toBe(expected);
    expect(normalizeLinkedinUrl('https://ca.linkedin.com/in/member-one')).toBe(expected);
  });

  it('drops anything that is not a LinkedIn profile link', () => {
    expect(normalizeLinkedinUrl('https://example.com/in/member-one')).toBeNull();
    expect(normalizeLinkedinUrl('https://www.linkedin.com/company/uconsulting')).toBeNull();
    expect(normalizeLinkedinUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeLinkedinUrl('   ')).toBeNull();
    expect(normalizeLinkedinUrl(null)).toBeNull();
  });
});

describe('needsCycleConfirmation', () => {
  const user = { profileImage: 'photo.jpg' };

  it('requires confirmation when the profile is incomplete', () => {
    expect(needsCycleConfirmation({ profile: null, user, activeCycleId: 'cycle-1' })).toBe(true);
  });

  it('requires confirmation once per cycle', () => {
    expect(needsCycleConfirmation({ profile: completeProfile, user, activeCycleId: 'cycle-1' })).toBe(true);

    const confirmed = { ...completeProfile, confirmations: [{ cycleId: 'cycle-1' }] };
    expect(needsCycleConfirmation({ profile: confirmed, user, activeCycleId: 'cycle-1' })).toBe(false);

    // New cycle has no confirmation row, so the modal fires again.
    expect(needsCycleConfirmation({ profile: confirmed, user, activeCycleId: 'cycle-2' })).toBe(true);
  });

  it('does not require confirmation when there is no active cycle', () => {
    expect(needsCycleConfirmation({ profile: completeProfile, user, activeCycleId: null })).toBe(false);
  });
});
