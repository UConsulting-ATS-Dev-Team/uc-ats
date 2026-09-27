// Pins vitest.setup.js: once config.js has loaded server/.env, which on a
// developer's machine is the production database and live SES credentials,
// tests must still point nowhere real.
import { describe, it, expect } from 'vitest';
import './config.js';

describe('the test environment', () => {
  it('has no real database', () => {
    expect(new URL(process.env.DATABASE_URL).host).toBe('127.0.0.1:1');
    expect(process.env.DIRECT_URL).toBe(process.env.DATABASE_URL);
  });

  it('cannot send email or Slack messages', () => {
    expect(process.env.AWS_ACCESS_KEY_ID).toBe('vitest-no-send');
    expect(process.env.AWS_ENDPOINT_URL).toBe('http://127.0.0.1:1');
    expect(process.env.EMAIL_PASS).toBe('');
    expect(process.env.SLACK_WEBHOOK_URL).toBe('');
  });
});
