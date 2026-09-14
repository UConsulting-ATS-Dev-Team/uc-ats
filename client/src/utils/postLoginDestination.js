/**
 * Where somebody lands straight after signing in.
 *
 * ProtectedRoute enforces all of this again, so getting it wrong is a visible
 * redirect rather than a broken page - which is exactly why it is worth getting
 * right in one place instead of three. Google sign-in made it matter more: it
 * can hand back a brand-new talent account, which has nothing to see on the
 * application list.
 */
export const postLoginDestination = (user) => {
  if (user?.role === 'CLIENT') return '/partner/resumes';
  if (user?.isExternalTalent) return '/talent/profile';
  // A candidate's home is their own dashboard. /application-list is the
  // admin and member review queue, which denies them - this page used to send
  // every non-CLIENT account there, so a candidate signing in with a password
  // hit the same wall long before Google sign-in existed.
  if (user?.role === 'USER') return '/dashboard';
  return '/application-list';
};
