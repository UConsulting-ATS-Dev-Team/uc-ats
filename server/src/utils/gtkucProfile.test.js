import { describe, it, expect } from 'vitest';
import {
  GTKUC_INDUSTRIES,
  GTKUC_INTERESTS,
  MAX_INDUSTRIES,
  sanitizeProfileInput,
  isProfileComplete,
  missingProfileFields,
  toCandidateCard,
  needsCycleConfirmation,
} from './gtkucProfile.js';

const completeProfile = {
  industries: [GTKUC_INDUSTRIES[0]],
  interests: [GTKUC_INTERESTS[0]],
  relevance: 'Happy to talk about recruiting timelines.',
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
  it('drops values outside the taxonomy, including company names', () => {
    const result = sanitizeProfileInput({
      industries: [GTKUC_INDUSTRIES[0], 'McKinsey & Company'],
      interests: [GTKUC_INTERESTS[0], 'Goldman Sachs'],
      relevance: '  transferred in as a junior  ',
    });

    expect(result.industries).toEqual([GTKUC_INDUSTRIES[0]]);
    expect(result.interests).toEqual([GTKUC_INTERESTS[0]]);
    expect(result.relevance).toBe('transferred in as a junior');
    expect(result.rejected).toEqual(['McKinsey & Company', 'Goldman Sachs']);
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
  it('requires tags, relevance, and a photo when a user is given', () => {
    expect(isProfileComplete(completeProfile, { profileImage: 'photo.jpg' })).toBe(true);
    expect(isProfileComplete(completeProfile, { profileImage: null })).toBe(false);
    expect(isProfileComplete(null)).toBe(false);
  });

  it('lists what is still missing', () => {
    expect(missingProfileFields({ industries: [], interests: [], relevance: '' }, { profileImage: null })).toEqual([
      'industries',
      'interests',
      'relevance',
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
      relevance: completeProfile.relevance,
    });
  });

  it('returns null when hidden, opted out, or incomplete', () => {
    expect(toCandidateCard({ ...member, gtkucProfile: { ...completeProfile, hiddenFromGtkuc: true } })).toBeNull();
    expect(toCandidateCard({ ...member, gtkucProfile: { ...completeProfile, candidateVisible: false } })).toBeNull();
    expect(toCandidateCard({ ...member, gtkucProfile: { ...completeProfile, relevance: '' } })).toBeNull();
    expect(toCandidateCard({ profileImage: 'photo.jpg' })).toBeNull();
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
