import { useState, useLayoutEffect, useCallback, useMemo } from 'react';
import PersonIcon from '@mui/icons-material/Person';
import AuthenticatedImage from './AuthenticatedImage';

const ALPHANUM = /[A-Za-z0-9]/;
const LETTER = /[A-Za-z]/;

export const getInitials = (firstName, lastName) => {
  const parts = [String(firstName ?? '').trim(), String(lastName ?? '').trim()].filter(Boolean);
  const chars = parts.map((part) => {
    const match = part.match(ALPHANUM);
    return match ? match[0] : '';
  });
  const initials = chars.join('').toUpperCase();
  return LETTER.test(initials) ? initials : '';
};

export const getDisplayName = (firstName, lastName) => {
  const full = `${String(firstName ?? '').trim()} ${String(lastName ?? '').trim()}`.trim();
  return full || 'Candidate avatar';
};

const isValidImageUrl = (url) => typeof url === 'string' && url.trim().length > 0;

const CandidateAvatar = ({
  applicant,
  className = 'candidate-avatar',
  fallbackClassName = 'candidate-avatar-fallback',
  style,
}) => {
  const [hasError, setHasError] = useState(false);

  const record = applicant?.applications?.[0] ?? applicant;
  const headshotUrl = record?.headshotUrl;
  const firstName = record?.firstName ?? applicant?.firstName ?? '';
  const lastName = record?.lastName ?? applicant?.lastName ?? '';

  useLayoutEffect(() => {
    setHasError(false);
  }, [headshotUrl]);

  const handleError = useCallback(() => setHasError(true), []);

  const initials = useMemo(() => getInitials(firstName, lastName), [firstName, lastName]);
  const displayName = useMemo(() => getDisplayName(firstName, lastName), [firstName, lastName]);
  const imageStyle = useMemo(() => ({ objectFit: 'cover', ...style }), [style]);

  if (!isValidImageUrl(headshotUrl) || hasError) {
    return (
      <div
        className={fallbackClassName}
        aria-label={displayName}
        title={displayName}
        role="img"
        style={imageStyle}
      >
        {initials || <PersonIcon aria-hidden="true" />}
      </div>
    );
  }

  return (
    <AuthenticatedImage
      src={headshotUrl}
      alt={displayName}
      className={className}
      style={imageStyle}
      onError={handleError}
    />
  );
};

export default CandidateAvatar;
