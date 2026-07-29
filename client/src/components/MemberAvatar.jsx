import { useState, useCallback, useEffect, useRef } from 'react';
import AuthenticatedImage from './AuthenticatedImage';

export const getInitials = (fullName) => {
  const name = String(fullName || '').trim();
  if (!name) return '';
  const parts = name.split(/\s+/).filter(Boolean);
  const first = parts[0]?.charAt(0) || '';
  const last = parts.length > 1 ? parts[parts.length - 1].charAt(0) : '';
  return `${first}${last}`.toUpperCase();
};

export const getMemberDisplayName = (member, fallback = 'Member') => {
  const display = String(
    member?.fullName ||
    member?.name ||
    member?.displayName ||
    ''
  ).trim();
  return display || fallback;
};

export const getMemberImageUrl = (member) => {
  const raw = member?.profileImage ?? member?.avatar ?? member?.profile_image ?? '';
  return typeof raw === 'string' ? raw.trim() : '';
};

const isValidImageUrl = (profileImage) => {
  return typeof profileImage === 'string' && profileImage.trim().length > 0;
};

const DEFAULT_BG = 'var(--primary-blue)';
const DEFAULT_COLOR = 'var(--text-white)';

const MemberAvatar = ({ member, size = 32, className = '', style = {} }) => {
  const [hasError, setHasError] = useState(false);
  const handleError = useCallback(() => setHasError(true), []);
  const didMountRef = useRef(false);

  const displayName = getMemberDisplayName(member);
  const initials = getInitials(getMemberDisplayName(member, ''));
  const profileImage = getMemberImageUrl(member);

  useEffect(() => {
    if (didMountRef.current) {
      setHasError(false);
    } else {
      didMountRef.current = true;
    }
  }, [profileImage]);

  const baseStyle = {
    width: size,
    height: size,
    borderRadius: '50%',
    ...style,
  };

  const fallbackStyle = {
    ...baseStyle,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: DEFAULT_BG,
    color: DEFAULT_COLOR,
    fontSize: Math.max(10, size * 0.4),
    fontWeight: 600,
    lineHeight: 1,
    overflow: 'hidden',
    flexShrink: 0,
  };

  const imageStyle = {
    ...baseStyle,
    objectFit: 'cover',
  };

  const combinedClass = `member-avatar${className ? ` ${className}` : ''}`;

  if (!member || !isValidImageUrl(profileImage) || hasError) {
    return (
      <div
        className={`member-avatar-fallback${className ? ` ${className}` : ''}`}
        aria-label={displayName}
        title={displayName}
        role="img"
        style={fallbackStyle}
      >
        {initials || '?'}
      </div>
    );
  }

  return (
    <AuthenticatedImage
      src={profileImage}
      alt={displayName}
      className={combinedClass}
      style={imageStyle}
      onError={handleError}
      title={displayName}
    />
  );
};

export default MemberAvatar;
