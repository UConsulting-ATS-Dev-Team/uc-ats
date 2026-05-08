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

const config = {
  port: process.env.PORT || 3001,
  jwtSecret: process.env.JWT_SECRET || 'fallback-secret-key', 

  dbUrl: process.env.DATABASE_URL,
  gCloudKeyPath: process.env.GOOGLE_CLOUD_KEY_PATH ? path.resolve(process.env.GOOGLE_CLOUD_KEY_PATH) : null,
  
  // Base URL for file serving - defaults based on environment
  baseUrl: process.env.BASE_URL || (process.env.NODE_ENV === 'production' ? 'https://uconsultingats.com' : 'http://localhost:3001'),
  
  // Client URL for frontend links (password reset, etc.) - defaults based on environment
  clientUrl: process.env.CLIENT_URL || (process.env.NODE_ENV === 'production' ? 'https://uconsultingats.com' : 'http://localhost:5173'),

  form: formConfig,

  /** Fine-grained PAT with Issues write on the ATS repo */
  githubFeatureRequestToken: process.env.GITHUB_FEATURE_REQUEST_TOKEN || null,
  /** owner/repo for GitHub Issues API (defaults to primary product repo) */
  githubFeatureRequestRepo:
    process.env.GITHUB_FEATURE_REQUEST_REPO || 'uconsulting/uc-ats',
};

export default config;