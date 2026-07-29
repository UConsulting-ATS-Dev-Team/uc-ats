import { vi } from 'vitest';

// Ensure required environment variables are present before any modules are loaded.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-production';
process.env.MEMBER_REGISTRATION_TOKEN = process.env.MEMBER_REGISTRATION_TOKEN || 'test-member-token';
