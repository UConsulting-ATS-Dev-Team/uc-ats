import { OAuth2Client } from 'google-auth-library';
import prisma from '../prismaClient.js';
import config from '../config.js';
import { invalidateUserCache } from '../middleware/auth.js';
import { normalizeEmail, FULL_NAME_MAX_LENGTH } from '../utils/externalTalent.js';

/**
 * Sign in with Google.
 *
 * The browser hands us an ID token minted by Google for our own client id. This
 * file's whole job is to turn that into a User row: verify the token really came
 * from Google, then decide whether it belongs to an account we already have or
 * to somebody new.
 *
 * Note this does not reuse services/google/auth.js. That is a *service account*
 * this server acts as when it reads Forms and Drive; verifying a person's ID
 * token is a different credential and a different client.
 */

/** An expected refusal, carrying the status the route should answer with. */
export class GoogleAuthError extends Error {
  constructor(message, { status = 401, code } = {}) {
    super(message);
    this.name = 'GoogleAuthError';
    this.status = status;
    this.code = code;
  }
}

let cachedClient = null;

const getClient = () => {
  if (!cachedClient) {
    cachedClient = new OAuth2Client(config.googleClientId);
  }
  return cachedClient;
};

/** Test seam, and a way to drop the client if the id ever changes at runtime. */
export const resetGoogleClient = () => {
  cachedClient = null;
};

/**
 * The part of a Google ID token we actually use. `sub` is the stable account
 * identifier; the email can change under it, which is why sub is what we store.
 */
export const verifyGoogleCredential = async (credential) => {
  if (!config.googleClientId) {
    throw new GoogleAuthError('Google sign-in is not configured', {
      status: 503,
      code: 'GOOGLE_NOT_CONFIGURED'
    });
  }

  if (typeof credential !== 'string' || credential.trim() === '') {
    throw new GoogleAuthError('Google sign-in failed', { code: 'GOOGLE_BAD_CREDENTIAL' });
  }

  let payload;
  try {
    const ticket = await getClient().verifyIdToken({
      idToken: credential,
      // Rejects a token minted for somebody else's Google client. Without this
      // the signature would still check out and anyone's token would work.
      audience: config.googleClientId
    });
    payload = ticket.getPayload();
  } catch (error) {
    // The library's messages describe JWT internals; they are no use to the
    // person signing in and hint at what to tamper with next.
    console.error('Google ID token verification failed:', error.message);
    throw new GoogleAuthError('Google sign-in failed', { code: 'GOOGLE_BAD_CREDENTIAL' });
  }

  const email = normalizeEmail(payload?.email);

  if (!payload?.sub || !email) {
    throw new GoogleAuthError('Google sign-in failed', { code: 'GOOGLE_BAD_CREDENTIAL' });
  }

  // Refused rather than treated as unproven. Everything below keys off the
  // address - an unverified one would let somebody claim an email they do not
  // read and be linked straight into whichever account already holds it.
  if (payload.email_verified !== true) {
    throw new GoogleAuthError(
      'Your Google account has not verified that email address.',
      { code: 'GOOGLE_EMAIL_UNVERIFIED' }
    );
  }

  return {
    googleId: payload.sub,
    email,
    fullName:
      typeof payload.name === 'string'
        ? payload.name.trim().slice(0, FULL_NAME_MAX_LENGTH)
        : ''
    // payload.picture is deliberately dropped. profileImage is what
    // utils/gtkucProfile.js:163 reads to decide a member has supplied a profile
    // picture, so filling it from Google would mark a GTKUC profile complete
    // with a photo the member never chose - and Google's avatar URLs rot when
    // the account changes, leaving dead images in the member directory.
  };
};

/**
 * Case-insensitive, because /register and /register-member historically stored
 * the address exactly as typed while Google always reports it lowercased. The
 * migration backfilled those rows and a unique index on lower(email) keeps them
 * that way, so in practice this matches at most one - but it reads two so that a
 * collision is refused rather than resolved by whichever row sorted first.
 */
const findByEmail = async (email) => {
  const matches = await prisma.user.findMany({
    where: { email: { equals: email, mode: 'insensitive' } },
    take: 2
  });

  if (matches.length <= 1) return matches[0] || null;

  const exact = matches.find((candidate) => candidate.email === email);
  if (exact) return exact;

  throw new GoogleAuthError(
    'More than one account uses this email address. Contact recruitment.',
    { status: 409, code: 'GOOGLE_AMBIGUOUS_EMAIL' }
  );
};

const assertActive = (user) => {
  if (user.isActive === false) {
    throw new GoogleAuthError('Account deactivated', { code: 'ACCOUNT_DEACTIVATED' });
  }
  return user;
};

/**
 * Attach Google to an account that already exists.
 *
 * Linking on a verified matching email alone, with no password prompt, is
 * deliberate: control of the mailbox is exactly the proof /forgot-password
 * already accepts, so asking for the password would add nothing and would shut
 * out the people most likely to want this.
 */
const linkExisting = async (user, profile) => {
  const data = {
    googleId: profile.googleId,
    googleLinkedAt: new Date()
  };

  // Google has verified the address, which is the same thing our own emailed
  // link proves. Only ever filled in, never cleared. Reached only from the
  // email-match branch, so the address Google proved is this row's address.
  if (!user.emailVerifiedAt) {
    data.emailVerifiedAt = new Date();
    // A verification token that outlives the thing it verifies is an account
    // takeover primitive - same reason /verify-email clears it on use.
    data.emailVerificationToken = null;
    data.emailVerificationExpiry = null;
  }

  const updated = await prisma.user.update({ where: { id: user.id }, data });

  // The middleware caches users for five minutes and emailVerifiedAt is part of
  // what it caches; without this the account stays "unverified" for the rest of
  // the window and the talent portal keeps its uploads disabled.
  invalidateUserCache(updated.id);

  return updated;
};

/**
 * Somebody with no account here at all. They become a talent-portal account:
 * role USER with isExternalTalent, and deliberately no Candidate row, because
 * they have not applied to anything and inventing one would put a stranger in
 * the recruiting pipeline. graduationClass is left null - Google cannot tell us
 * and the talent profile asks for it.
 *
 * Deliberately NOT gated on isUclaEmail, unlike /register-external, which
 * refuses anything outside ucla.edu. That asymmetry is a decision, not an
 * oversight: Google sign-up is open to any address. The consequence to know is
 * that a resume reaching Talent Partner Network buyers with source 'PORTAL' no
 * longer implies its owner is a verified UCLA student. Add isUclaEmail here if
 * that ever needs to be true again.
 */
const createFromGoogle = (profile) =>
  prisma.user.create({
    data: {
      email: profile.email,
      password: null,
      fullName: profile.fullName || profile.email.split('@')[0],
      role: 'USER',
      isExternalTalent: true,
      emailVerifiedAt: new Date(),
      googleId: profile.googleId,
      googleLinkedAt: new Date()
    }
  });

/**
 * Resolution order. googleId first so that somebody who renames their Google
 * address still lands in their own account instead of having a second one made
 * for the new address.
 */
export const resolveGoogleUser = async (profile) => {
  const byGoogleId = await prisma.user.findUnique({ where: { googleId: profile.googleId } });
  if (byGoogleId) {
    return { user: assertActive(byGoogleId), isNewAccount: false };
  }

  const byEmail = await findByEmail(profile.email);
  if (byEmail) {
    // Checked before the write, so a deactivated account is not quietly linked.
    assertActive(byEmail);
    return { user: await linkExisting(byEmail, profile), isNewAccount: false };
  }

  try {
    return { user: await createFromGoogle(profile), isNewAccount: true };
  } catch (error) {
    // Two first-time sign-ins racing each other: one create wins, the other
    // trips the unique index on email or googleId. The loser re-reads rather
    // than failing, since by then the account it wanted exists.
    if (error?.code === 'P2002') {
      const existing =
        (await prisma.user.findUnique({ where: { googleId: profile.googleId } })) ||
        (await findByEmail(profile.email));
      if (existing) return { user: assertActive(existing), isNewAccount: false };
    }
    throw error;
  }
};

export const signInWithGoogle = async (credential) =>
  resolveGoogleUser(await verifyGoogleCredential(credential));
