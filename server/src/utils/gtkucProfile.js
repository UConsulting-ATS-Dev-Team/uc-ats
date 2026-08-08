// Shared taxonomy + validation for the GTKUC member profile shown to candidates.
// Industries are a fixed taxonomy on purpose: candidates see the industry a
// member has experience in, never the employer name.

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
    relevance: profile.relevance,
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
