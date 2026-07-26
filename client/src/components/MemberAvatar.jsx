import { useState, useCallback } from 'react';
import AuthenticatedImage from './AuthenticatedImage';

export const getInitials = (fullName) => {
  const name = String(fullName || '').trim();
  if (!name) return '';
  const parts = name.split(/\s+/);
  const first = parts[0]?.charAt(0) || '';
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
  return `${first}${last}`.toUpperCase();
};

const getDisplayName = (member) => {
  return String(member?.fullName || '').trim() || 'Member';
};

const isValidImageUrl = (profileImage) => {
  return typeof profileImage === 'string' && profileImage.trim().length > 0;
};

const MemberAvatar = ({ member }) => {
  const [hasError, setHasError] = useState(false);
  const handleError = useCallback(() => setHasError(true), []);

  const displayName = getDisplayName(member);
  const initials = getInitials(member?.fullName);
  const profileImage = member?.profileImage;

  if (!member || !isValidImageUrl(profileImage) || hasError) {
    return (
      <div
        className="member-avatar-fallback"
        aria-label={displayName}
        title={displayName}
        role="img"
      >
        {initials || '?'}
      </div>
    );
  }

  return (
    <AuthenticatedImage
      src={profileImage}
      alt={displayName}
      className="member-avatar"
      style={{ width: '32px', height: '32px', borderRadius: '50%', objectFit: 'cover' }}
      onError={handleError}
      title={displayName}
    />
  );
};

export default MemberAvatar;
