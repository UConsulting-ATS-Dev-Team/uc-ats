import { useCallback, useEffect, useState } from 'react';
import { Avatar } from '@mui/material';
import PersonIcon from '@mui/icons-material/Person';
import AuthenticatedImage from '../AuthenticatedImage';
import { getInitials } from '../CandidateAvatar';

// A round headshot that falls back to initials when there is no photo or it
// fails to load, instead of AuthenticatedImage's "Photo unavailable" box.
export default function Headshot({ src, name = '', size = 40, sx }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  const onError = useCallback(() => setFailed(true), []);

  const [first, ...rest] = name.split(' ');
  const initials = getInitials(first, rest.join(' '));

  return (
    <Avatar
      alt={name}
      sx={{ width: size, height: size, fontSize: size * 0.36, bgcolor: 'grey.300', color: 'grey.700', ...sx }}
    >
      {src && !failed ? (
        <AuthenticatedImage
          src={src}
          alt={name}
          onError={onError}
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      ) : (
        initials || <PersonIcon fontSize="inherit" />
      )}
    </Avatar>
  );
}
