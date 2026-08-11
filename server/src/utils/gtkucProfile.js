// Shared taxonomy + validation for the GTKUC member profile shown to candidates.
// Industries are a fixed taxonomy on purpose: candidates see the industry a
// member has experience in, never the employer name.
//
// The relevance blurb is member-authored free text, so the taxonomy alone cannot
// keep an employer name out of it. It is therefore gated on explicit admin
// review: `relevance` is the member's draft and is never projected, while
// `approvedRelevance` is the exact text an admin cleared and is the only blurb
// candidates or the public can see. Editing the draft returns it to review.
// (Deliberately not a blacklist or an AI filter: both fail open on wording the
// list did not anticipate.)

export const GTKUC_INDUSTRIES = [
  'Consulting',
  'Investment Banking',
  'Private Equity / Venture Capital',
  'Technology / Software',
  'Product Management',
  'Data / Analytics',
  'Healthcare / Biotech',
  'Entertainment / Media',
  'Consumer Goods / Retail',
  'Real Estate',
  'Energy / Sustainability',
  'Nonprofit / Social Impact',
  'Government / Policy',
  'Education',
  'Startups / Entrepreneurship',
  'Marketing / Advertising',
  'Accounting / Audit',
  'Law',
  'Engineering / Manufacturing',
  'Sports',
];

export const GTKUC_INTERESTS = [
  'Basketball',
  'Soccer',
  'Running',
  'Hiking',
  'Surfing',
  'Skiing / Snowboarding',
  'Fitness',
  'Cooking',
  'Coffee',
  'Travel',
  'Photography',
  'Music',
  'Film & TV',
  'Reading',
  'Gaming',
  'Fashion',
  'Art & Design',
  'Volunteering',
  'Investing',
  'Languages',
  'Dance',
  'Theater',
  'Writing',
  'Podcasts',
];

export const RELEVANCE_REVIEW_STATUSES = ['PENDING_REVIEW', 'APPROVED', 'REJECTED'];

export const RELEVANCE_MAX_LENGTH = 500;
export const MAX_INDUSTRIES = 5;
export const MAX_INTERESTS = 8;

// Keeps only values from the taxonomy, de-duplicated and capped. Anything a
// client sends that isn't in the taxonomy (e.g. a company name typed into the
// industries field) is dropped rather than stored.
const sanitizeTags = (values, taxonomy, max) => {
  if (!Array.isArray(values)) return [];
  const allowed = new Set(taxonomy);
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const tag = value.trim();
    if (!allowed.has(tag) || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
    if (result.length >= max) break;
  }
  return result;
};

// Normalizes a profile payload from the member portal. Returns the sanitized
// values plus the tags that were rejected so the API can tell the member why.
export const sanitizeProfileInput = (input = {}) => {
  const industries = sanitizeTags(input.industries, GTKUC_INDUSTRIES, MAX_INDUSTRIES);
  const interests = sanitizeTags(input.interests, GTKUC_INTERESTS, MAX_INTERESTS);
  const relevance =
    typeof input.relevance === 'string' ? input.relevance.trim().slice(0, RELEVANCE_MAX_LENGTH) : '';

  const rejected = [
    ...(Array.isArray(input.industries) ? input.industries : []),
    ...(Array.isArray(input.interests) ? input.interests : []),
  ].filter(
    (value) =>
      typeof value === 'string' &&
      value.trim() &&
      !industries.includes(value.trim()) &&
      !interests.includes(value.trim())
  );

  return {
    industries,
    interests,
    relevance,
    candidateVisible: input.candidateVisible === undefined ? true : Boolean(input.candidateVisible),
    rejected,
  };
};

// A profile is complete once the member has at least one industry, one interest,
// and a relevance blurb. Photo is checked separately against the user record.
export const isProfileComplete = (profile, user = null) => {
  if (!profile) return false;
  const hasTags = profile.industries?.length > 0 && profile.interests?.length > 0;
  const hasRelevance = Boolean(profile.relevance && profile.relevance.trim());
  const hasPhoto = user ? Boolean(user.profileImage) : true;
  return Boolean(hasTags && hasRelevance && hasPhoto);
};

// Missing pieces, for empty-state messaging in the portal.
export const missingProfileFields = (profile, user = null) => {
  const missing = [];
  if (!profile?.industries?.length) missing.push('industries');
  if (!profile?.interests?.length) missing.push('interests');
  if (!profile?.relevance || !profile.relevance.trim()) missing.push('relevance');
  if (user && !user.profileImage) missing.push('profilePicture');
  return missing;
};

// The only blurb text that may leave the server for a candidate or the public.
// An approved snapshot stays visible while a newer draft is in review, so a
// member cannot make unreviewed text visible by editing an approved profile.
export const visibleRelevance = (profile) => {
  const approved = profile?.approvedRelevance;
  if (typeof approved !== 'string' || !approved.trim()) return null;
  return profile.relevanceReviewStatus === 'APPROVED' ? approved.trim() : null;
};

// Fields to persist when a member saves a blurb draft. Re-submitting the exact
// approved text is not a change and keeps its approval; anything else needs a
// fresh review before candidates see it.
export const relevanceDraftUpdate = (profile, draft) => {
  const text = typeof draft === 'string' ? draft.trim() : '';
  const approved = typeof profile?.approvedRelevance === 'string' ? profile.approvedRelevance.trim() : '';

  if (text && text === approved && profile?.relevanceReviewStatus === 'APPROVED') {
    return { relevance: text };
  }

  return {
    relevance: text,
    relevanceReviewStatus: 'PENDING_REVIEW',
    relevanceReviewNote: null,
    relevanceReviewedAt: null,
    relevanceReviewedById: null
  };
};

// Fields to persist for an admin decision on the current draft. Approving
// snapshots the exact text reviewed, so a later edit cannot ride on the
// approval; rejecting withdraws any previously approved text.
export const relevanceReviewUpdate = ({ profile, decision, note, reviewerId }) => {
  const base = {
    relevanceReviewNote: typeof note === 'string' && note.trim() ? note.trim() : null,
    relevanceReviewedAt: new Date(),
    relevanceReviewedById: reviewerId || null
  };

  if (decision === 'APPROVE') {
    const text = typeof profile?.relevance === 'string' ? profile.relevance.trim() : '';
    if (!text) return null;
    return { ...base, relevanceReviewStatus: 'APPROVED', approvedRelevance: text };
  }

  if (decision === 'REJECT') {
    return { ...base, relevanceReviewStatus: 'REJECTED', approvedRelevance: null };
  }

  return null;
};

// Candidate-facing projection. Returns null when the member opted out of being
// shown, was hidden by an admin, or hasn't filled the profile in yet.
export const toCandidateCard = (member) => {
  const profile = member?.gtkucProfile;
  if (!profile || profile.hiddenFromGtkuc || !profile.candidateVisible) return null;
  if (!isProfileComplete(profile)) return null;
  return {
    photo: member.profileImage || null,
    graduationClass: member.graduationClass || null,
    industries: profile.industries,
    interests: profile.interests,
    relevance: visibleRelevance(profile),
  };
};

// Whether the member must confirm their profile before opening slots in this
// cycle. Default policy is required: incomplete profile or no confirmation row
// for the active cycle both block slot creation.
export const needsCycleConfirmation = ({ profile, user, activeCycleId }) => {
  if (!isProfileComplete(profile, user)) return true;
  if (!activeCycleId) return false;
  return !profile.confirmations?.some((confirmation) => confirmation.cycleId === activeCycleId);
};
