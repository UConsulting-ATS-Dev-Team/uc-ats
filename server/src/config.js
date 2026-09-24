import fs from 'node:fs';
import path from 'node:path';

import dotenv from 'dotenv';

dotenv.config();

// Handle missing FORM_CONFIG_PATH gracefully
let formConfig = {};
if (process.env.FORM_CONFIG_PATH) {
  try {
    const formConfigPath = path.resolve(process.env.FORM_CONFIG_PATH);
    formConfig = JSON.parse(fs.readFileSync(formConfigPath, 'utf8'));
  } catch (error) {
    console.warn('Warning: Could not load form config:', error.message);
  }
}

if (!process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET is required. Set it in the environment before starting the server.');
}

if (!process.env.MEMBER_REGISTRATION_TOKEN) {
  throw new Error('MEMBER_REGISTRATION_TOKEN is required. Set it in the environment before starting the server.');
}

const isProduction = process.env.NODE_ENV === 'production';

// Render preview environments get a fresh hostname per pull request, which no
// static config value can anticipate. Render exposes that hostname as
// RENDER_EXTERNAL_URL and flags previews with IS_PULL_REQUEST, so a preview can
// point its self-referential URLs at itself. Guarded on IS_PULL_REQUEST so the
// long-lived production service keeps using its explicit BASE_URL/CLIENT_URL.
const isPreviewEnv = process.env.IS_PULL_REQUEST === 'true';
const renderUrl = process.env.RENDER_EXTERNAL_URL || null;
const previewUrl = isPreviewEnv ? renderUrl : null;

const explicitCorsOrigin = process.env.CORS_ORIGIN
  ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
  : (isProduction ? ['https://uconsultingats.com'] : ['http://localhost:5173']);

// When this service also serves the SPA, the browser sends an Origin header on
// same-origin writes, so the service's own URL has to be on the allowlist.
// Appended rather than substituted — never removes a configured origin.
const corsOrigin = renderUrl && !explicitCorsOrigin.includes(renderUrl)
  ? [...explicitCorsOrigin, renderUrl]
  : explicitCorsOrigin;

const config = {
  port: process.env.PORT || 3001,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',

  // Keys live vote ballots to voters (see services/liveVotes.js). Optional: falls
  // back to jwtSecret. Rotating it mid-session makes open ballots forget who has
  // already voted, so change it between sessions.
  liveVoteSecret: process.env.LIVE_VOTE_SECRET || process.env.JWT_SECRET,

  // Signs the unsubscribe links in Master Communications footers. Falls back to
  // jwtSecret. Rotating it breaks every unsubscribe link already in an inbox,
  // so set it once and leave it.
  unsubscribeSecret: process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET,

  memberRegistrationToken: process.env.MEMBER_REGISTRATION_TOKEN,

  dbUrl: process.env.DATABASE_URL,
  gCloudKeyPath: process.env.GOOGLE_CLOUD_KEY_PATH ? path.resolve(process.env.GOOGLE_CLOUD_KEY_PATH) : null,

  /**
   * OAuth client id for "Sign in with Google". Nothing to do with
   * GOOGLE_CLOUD_KEY_PATH above - that is a service account this server acts as
   * when reading Forms and Drive, this is the browser-facing client a person
   * signs in through, and the two are different credentials in Google Cloud.
   *
   * Public by design: the same value ships in the client bundle as
   * VITE_GOOGLE_CLIENT_ID, and it must match, since it is the `audience` an ID
   * token is verified against. There is no client secret in this flow.
   *
   * Optional rather than required. Only JWT_SECRET and MEMBER_REGISTRATION_TOKEN
   * are allowed to stop the server from booting; unset here simply means the
   * Google endpoint answers 503 and password login carries on.
   */
  googleClientId: process.env.GOOGLE_OAUTH_CLIENT_ID || null,

  baseUrl: process.env.BASE_URL || previewUrl || (isProduction ? 'https://uconsultingats.com' : 'http://localhost:3001'),
  clientUrl: process.env.CLIENT_URL || previewUrl || (isProduction ? 'https://uconsultingats.com' : 'http://localhost:5173'),

  corsOrigin,

  /**
   * Where operational alerts addressed to recruitment go - currently the
   * "every interview slot is full, this candidate needs placing by hand" case.
   * Falls back to the reply-to address, which is already monitored by whoever
   * answers candidate mail, so an unset variable degrades to the right inbox
   * rather than to nobody.
   */
  recruitmentEmail: process.env.RECRUITMENT_EMAIL || process.env.EMAIL_REPLY_TO || process.env.EMAIL_USER || null,

  /**
   * Whether interview scheduling emails actually leave the building.
   *
   * Off unless SCHEDULING_EMAILS=on, deliberately. This feature emails real
   * candidates the moment somebody books, cancels or is promoted, and it gets
   * poked at in a live cycle with real applicants in the database - so sending
   * is opt-in rather than something a fresh checkout does by surprise.
   *
   * Suppression is recorded, not silent: notifications are still written, marked
   * SUPPRESSED, and can be sent later from the roster once this is switched on.
   */
  schedulingEmailsEnabled: String(process.env.SCHEDULING_EMAILS || '').toLowerCase() === 'on',

  form: formConfig,

  /** Fine-grained PAT with Issues write on the ATS repo */
  githubFeatureRequestToken: process.env.GITHUB_FEATURE_REQUEST_TOKEN || null,
  /** owner/repo for GitHub Issues API (defaults to primary product repo) */
  githubFeatureRequestRepo:
    process.env.GITHUB_FEATURE_REQUEST_REPO || 'uconsulting/uc-ats',
};

export default config;