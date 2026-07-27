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

const config = {
  port: process.env.PORT || 3001,
  jwtSecret: process.env.JWT_SECRET,
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '8h',

  memberRegistrationToken: process.env.MEMBER_REGISTRATION_TOKEN,

  dbUrl: process.env.DATABASE_URL,
  gCloudKeyPath: process.env.GOOGLE_CLOUD_KEY_PATH ? path.resolve(process.env.GOOGLE_CLOUD_KEY_PATH) : null,

  baseUrl: process.env.BASE_URL || (isProduction ? 'https://uconsultingats.com' : 'http://localhost:3001'),
  clientUrl: process.env.CLIENT_URL || (isProduction ? 'https://uconsultingats.com' : 'http://localhost:5173'),

  // Google Calendar integration for meeting slot lifecycle invites.
  // GOOGLE_CALENDAR_ID gates all calendar provider calls until preflight approval.
  googleCalendarId: process.env.GOOGLE_CALENDAR_ID || null,
  calendarInviteTestEmail: process.env.CALENDAR_INVITE_TEST_EMAIL || null,

  corsOrigin: process.env.CORS_ORIGIN
    ? process.env.CORS_ORIGIN.split(',').map((o) => o.trim()).filter(Boolean)
    : (isProduction ? ['https://uconsultingats.com'] : ['http://localhost:5173']),

  form: formConfig,

  /** Fine-grained PAT with Issues write on the ATS repo */
  githubFeatureRequestToken: process.env.GITHUB_FEATURE_REQUEST_TOKEN || null,
  /** owner/repo for GitHub Issues API (defaults to primary product repo) */
  githubFeatureRequestRepo:
    process.env.GITHUB_FEATURE_REQUEST_REPO || 'uconsulting/uc-ats',
};

export default config;