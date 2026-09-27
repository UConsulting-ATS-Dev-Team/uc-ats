import { describe, it, expect, vi, afterEach } from 'vitest';

// config.js reads the environment once at import, so each case loads it fresh.
async function runCronsWith(env) {
  vi.resetModules();
  vi.stubEnv('JWT_SECRET', 'test');
  vi.stubEnv('MEMBER_REGISTRATION_TOKEN', 'test');
  vi.stubEnv('NODE_ENV', 'test');
  vi.stubEnv('RUN_CRONS', '');
  vi.stubEnv('IS_PULL_REQUEST', '');
  vi.stubEnv('RENDER_EXTERNAL_URL', '');
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  const { default: config } = await import('./config.js');
  return config.runCrons;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('config.runCrons', () => {
  it('runs on the production server', async () => {
    expect(await runCronsWith({ CLIENT_URL: 'https://uconsultingats.com' })).toBe(true);
  });

  it('does not run on a laptop, whose reminder links would point at localhost', async () => {
    expect(await runCronsWith({ CLIENT_URL: 'http://localhost:5173' })).toBe(false);
    expect(await runCronsWith({ CLIENT_URL: 'http://127.0.0.1:5173' })).toBe(false);
  });

  it('does not run in a Render preview, even one that shares production settings', async () => {
    expect(
      await runCronsWith({ CLIENT_URL: 'https://uconsultingats.com', IS_PULL_REQUEST: 'true' })
    ).toBe(false);
  });

  it('follows RUN_CRONS over either default', async () => {
    expect(await runCronsWith({ CLIENT_URL: 'http://localhost:5173', RUN_CRONS: 'true' })).toBe(true);
    expect(await runCronsWith({ CLIENT_URL: 'https://uconsultingats.com', RUN_CRONS: 'false' })).toBe(false);
  });
});
