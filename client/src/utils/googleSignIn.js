/**
 * Whether "Continue with Google" is switched on for this build.
 *
 * Vite inlines VITE_* at build time, so an unset variable is not a runtime
 * condition that might change - it is a build with no Google sign-in in it. One
 * module so the provider and the buttons cannot disagree, and so tests have a
 * single thing to mock.
 *
 * Must be the same client id the server holds as GOOGLE_OAUTH_CLIENT_ID: it is
 * the audience an ID token is verified against, and a mismatch fails every
 * sign-in with nothing useful in the browser console.
 */
export const GOOGLE_CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID || '';

export const googleSignInEnabled = Boolean(GOOGLE_CLIENT_ID);
