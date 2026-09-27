import { vi } from 'vitest';

// Ensure required environment variables are present before any modules are loaded.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-production';
process.env.MEMBER_REGISTRATION_TOKEN = process.env.MEMBER_REGISTRATION_TOKEN || 'test-member-token';

// Keep tests off every real service. config.js loads server/.env, which on a
// developer's machine points at the production database and holds live SES
// credentials, and a test that mocks only part of a send path reaches the rest
// for real: welcomeEmail.test.js mocked the transport but not the log, and
// wrote hundreds of fake "SENT" rows into production's communication_logs.
//
// dotenv never overrides a variable that is already set, so setting these here,
// before any module loads, is what wins. Each points somewhere that refuses at
// once, so an unmocked call fails fast instead of reaching anything.
process.env.DATABASE_URL = 'postgresql://vitest:vitest@127.0.0.1:1/no_database_in_tests';
process.env.DIRECT_URL = process.env.DATABASE_URL;
process.env.AWS_ACCESS_KEY_ID = 'vitest-no-send';
process.env.AWS_SECRET_ACCESS_KEY = 'vitest-no-send';
process.env.AWS_ENDPOINT_URL = 'http://127.0.0.1:1';
process.env.EMAIL_PASS = '';
process.env.SLACK_WEBHOOK_URL = '';
// File storage: Supabase holds resumes and profile images, Drive the rest.
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'vitest-no-access';
process.env.GOOGLE_CLOUD_KEY_PATH = '';
