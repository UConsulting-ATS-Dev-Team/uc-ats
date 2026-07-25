import { useState, useCallback } from 'react';
import AuthenticatedImage from './AuthenticatedImage';

export const getInitials = (firstName, lastName) => {
  const first = String(firstName || '').trim().charAt(0);
  const last = String(lastName || '').trim().charAt(0);
  return `${first}${last}`.toUpperCase();
};

const getDisplayName = (firstName, lastName) => {
  const full = `${String(firstName || '').trim()} ${String(lastName || '').trim()}`.trim();
  return full || 'Candidate avatar';
};

const isValidImageUrl = (headshotUrl) => {
  return typeof headshotUrl === 'string' && headshotUrl.trim().length > 0;
};

const CandidateAvatar = ({ applicant }) => {
  const [hasError, setHasError] = useState(false);
  const handleError = useCallback(() => setHasError(true), []);

  const headshotUrl = applicant?.headshotUrl;
  const initials = getInitials(applicant?.firstName, applicant?.lastName);
  const displayName = getDisplayName(applicant?.firstName, applicant?.lastName);

  if (!isValidImageUrl(headshotUrl) || hasError) {
    return (
      <div
        className="candidate-avatar-fallback"
        aria-label={displayName}
        role="img"
      >
        {initials}
      </div>
    );
  }

  return (
    <AuthenticatedImage
      src={headshotUrl}
      alt={displayName}
      className="candidate-avatar"
      style={{ width: '60px', height: '60px', borderRadius: '50%', objectFit: 'cover' }}
      onError={handleError}
    />
  );
};

export default CandidateAvatar;
