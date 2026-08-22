import { Avatar } from '@mui/material';
import MemberAvatar from './MemberAvatar';

const AuthenticatedAvatar = ({ member, size = 32, sx, className }) => (
  <Avatar className={className} sx={{ width: size, height: size, ...sx }}>
    <MemberAvatar member={member} size={size} style={{ width: '100%', height: '100%' }} />
  </Avatar>
);

export default AuthenticatedAvatar;
