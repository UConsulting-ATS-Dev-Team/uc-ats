// Shared taxonomy + validation for the GTKUC member profile shown to candidates.
// Industries are a fixed taxonomy on purpose: candidates see the industry a
// member has experience in, never the employer name.
//
// Everything candidate-visible here is either a taxonomy tag or the member's own
// LinkedIn URL, so there is no free-text field to review. LinkedIn URLs are
// normalized to linkedin.com profile links before they are stored.

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

export const MAX_INDUSTRIES = 5;
export const INTEREST_MAX_LENGTH = 40;
export const MAX_INTERESTS = 8;

// Accepts what members actually paste (bare handle, with or without scheme or
// www, trailing query junk) and returns a canonical https://www.linkedin.com/in/…
// URL. Anything that isn't a linkedin.com profile link is dropped rather than
// stored, so the icon candidates click can only ever point at LinkedIn.
export const normalizeLinkedinUrl = (value) => {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;

  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  const host = url.hostname.toLowerCase().replace(/^www\./, '');
  if (host !== 'linkedin.com' && !host.endsWith('.linkedin.com')) return null;

  const match = url.pathname.match(/^\/(in|pub)\/([^/]+)\/?$/i);
  if (!match) return null;

  return `https://www.linkedin.com/in/${decodeURIComponent(match[2])}`;
};

// Keeps only values from the taxonomy, de-duplicated and capped. Anything a
// client sends that isn't in the taxonomy (e.g. a company name typed into the
// industries field) is dropped rather than stored. This is what keeps employer
// names off the industries field, so industries stay closed to free text.
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

// Interests are the one open field: members add their own alongside the
// suggested list, since a hobby is not an employer and the taxonomy will never
// cover everything. Each one is trimmed, collapsed, length-capped, and
// de-duplicated case-insensitively; anything that survives none of that is
// dropped. Industries stay closed — see sanitizeTags.
const sanitizeInterests = (values, max) => {
  if (!Array.isArray(values)) return [];
  const seen = new Set();
  const result = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    // Control characters would let a member smuggle layout into a chip.
    const tag = value
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, INTEREST_MAX_LENGTH);
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    result.push(tag);
    if (result.length >= max) break;
  }
  return result;
};

// Normalizes a profile payload from the member portal. Returns the sanitized
// values plus the tags that were rejected so the API can tell the member why.
export const sanitizeProfileInput = (input = {}) => {
  const industries = sanitizeTags(input.industries, GTKUC_INDUSTRIES, MAX_INDUSTRIES);
  const interests = sanitizeInterests(input.interests, MAX_INTERESTS);
  const linkedinUrl = normalizeLinkedinUrl(input.linkedinUrl);

  // Only industries can be rejected outright — interests accept custom values,
  // so the portal only needs to be told about dropped industry tags.
  const rejected = (Array.isArray(input.industries) ? input.industries : []).filter(
    (value) => typeof value === 'string' && value.trim() && !industries.includes(value.trim())
  );

  return {
    industries,
    interests,
    linkedinUrl,
    candidateVisible: input.candidateVisible === undefined ? true : Boolean(input.candidateVisible),
    rejected,
  };
};

// A profile is complete once the member has at least one industry and one
// interest. Photo is checked separately against the user record; the LinkedIn
// link is auto-filled where we have it and never blocks slot creation.
export const isProfileComplete = (profile, user = null) => {
  if (!profile) return false;
  const hasTags = profile.industries?.length > 0 && profile.interests?.length > 0;
  const hasPhoto = user ? Boolean(user.profileImage) : true;
  return Boolean(hasTags && hasPhoto);
};

// Missing pieces, for empty-state messaging in the portal.
export const missingProfileFields = (profile, user = null) => {
  const missing = [];
  if (!profile?.industries?.length) missing.push('industries');
  if (!profile?.interests?.length) missing.push('interests');
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
    linkedinUrl: profile.linkedinUrl || null,
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
