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

  memberRegistrationToken: process.env.MEMBER_REGISTRATION_TOKEN,

  dbUrl: process.env.DATABASE_URL,
  gCloudKeyPath: process.env.GOOGLE_CLOUD_KEY_PATH ? path.resolve(process.env.GOOGLE_CLOUD_KEY_PATH) : null,

  baseUrl: process.env.BASE_URL || previewUrl || (isProduction ? 'https://uconsultingats.com' : 'http://localhost:3001'),
  clientUrl: process.env.CLIENT_URL || previewUrl || (isProduction ? 'https://uconsultingats.com' : 'http://localhost:5173'),

  corsOrigin,

  form: formConfig,

  /** Calendar that interview/event invites are written to (service account must have write access) */
  googleCalendarId: process.env.GOOGLE_CALENDAR_ID || null,
  /** When set, all calendar invites are redirected to this address instead of real attendees */
  calendarInviteTestEmail: process.env.CALENDAR_INVITE_TEST_EMAIL || null,

  /** Fine-grained PAT with Issues write on the ATS repo */
  githubFeatureRequestToken: process.env.GITHUB_FEATURE_REQUEST_TOKEN || null,
  /** owner/repo for GitHub Issues API (defaults to primary product repo) */
  githubFeatureRequestRepo:
    process.env.GITHUB_FEATURE_REQUEST_REPO || 'uconsulting/uc-ats',
};

export default config;