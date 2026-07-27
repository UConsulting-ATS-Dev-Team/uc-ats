import { useEffect, useState } from 'react';
import { Person as PersonIcon } from '@mui/icons-material';
import { getInitials } from './MemberAvatar';

const DEFAULT_SIZE = 32;
const DEFAULT_BG = '#1976d2';
const DEFAULT_COLOR = '#ffffff';

function isSafeProfileImageUrl(url) {
  if (typeof url !== 'string' || url.trim().length === 0) return false;
  const trimmed = url.trim();
  // Allow the same public /api/uploads paths the app already serves and
  // any external public image URL. Reject javascript/data URIs.
  return (
    trimmed.startsWith('/api/uploads/profile-images/') ||
    trimmed.startsWith('/uploads/profile-images/') ||
    trimmed.startsWith('http://') ||
    trimmed.startsWith('https://')
  );
}

export default function PublicHostAvatar({
  name,
  profileImage,
  size = DEFAULT_SIZE,
  className = '',
  style = {}
}) {
  const [hasError, setHasError] = useState(false);

  const displayName = typeof name === 'string' && name.trim().length > 0
    ? name.trim()
    : 'Member';
  const initials = getInitials(displayName);
  const safeUrl = isSafeProfileImageUrl(profileImage) ? profileImage.trim() : null;

  useEffect(() => {
    setHasError(false);
  }, [safeUrl]);

  const baseStyle = {
    width: size,
    height: size,
    borderRadius: '50%',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    overflow: 'hidden',
    fontSize: Math.max(10, size * 0.4),
    fontWeight: 600,
    lineHeight: 1,
    backgroundColor: DEFAULT_BG,
    color: DEFAULT_COLOR,
    ...style
  };

  if (!safeUrl || hasError) {
    return (
      <span
        className={`public-host-avatar public-host-avatar-fallback${className ? ` ${className}` : ''}`}
        role="img"
        aria-label={displayName}
        title={displayName}
        style={baseStyle}
      >
        {initials ? (
          <span aria-hidden="true">{initials}</span>
        ) : (
          <PersonIcon sx={{ fontSize: size * 0.55 }} aria-hidden="true" />
        )}
      </span>
    );
  }

  return (
    <img
      className={`public-host-avatar${className ? ` ${className}` : ''}`}
      src={safeUrl}
      alt={displayName}
      title={displayName}
      onError={() => setHasError(true)}
      style={{ ...baseStyle, objectFit: 'cover' }}
    />
  );
}
