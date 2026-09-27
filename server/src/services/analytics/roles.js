// The user types analytics reports on. `USER` covers two different people (see
// CLAUDE.md, Authentication), and their experience of the site has nothing in
// common, so they are split here.

export const ROLES = Object.freeze(['ADMIN', 'MEMBER', 'CANDIDATE', 'TALENT', 'CLIENT', 'ANON']);

export function roleOf(user) {
  if (!user) return 'ANON';
  switch (user.role) {
    case 'ADMIN':
      return 'ADMIN';
    case 'MEMBER':
      return 'MEMBER';
    case 'CLIENT':
      return 'CLIENT';
    case 'USER':
      return user.isExternalTalent ? 'TALENT' : 'CANDIDATE';
    default:
      return 'ANON';
  }
}
