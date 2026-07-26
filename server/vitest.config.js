import { defineConfig } from 'vitest/config';

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-do-not-use-in-production';
process.env.MEMBER_REGISTRATION_TOKEN = process.env.MEMBER_REGISTRATION_TOKEN || 'test-member-token';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['./vitest.setup.js'],
  },
});
