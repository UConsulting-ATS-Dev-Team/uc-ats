#!/usr/bin/env node

// Deterministic verification script for scripts/check-db.js.
// Run from the server directory with a real DATABASE_URL, e.g.:
//   DATABASE_URL=postgresql://... DIRECT_URL=postgresql://... npm run verify:check-db
//
// It exercises:
//   - .env file loading via DOTENV_CONFIG_PATH
//   - missing/invalid DATABASE_URL and DIRECT_URL
//   - a valid DATABASE_URL with an invalid DIRECT_URL returns nonzero
//   - a valid DATABASE_URL with a valid DIRECT_URL returns 0

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scriptPath = new URL('check-db.js', import.meta.url).pathname;
const projectDir = new URL('..', import.meta.url).pathname;

function run(envPatch) {
  const childEnv = { ...process.env };
  for (const [key, value] of Object.entries(envPatch)) {
    if (value === undefined) {
      delete childEnv[key];
    } else {
      childEnv[key] = value;
    }
  }

  const result = spawnSync(process.execPath, [scriptPath], {
    cwd: projectDir,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return {
    status: result.status,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString()
  };
}

console.log('Verifying scripts/check-db.js ...\n');

let passed = 0;
let failed = 0;

function check(condition, message) {
  if (condition) {
    passed++;
    console.log('PASS:', message);
  } else {
    failed++;
    console.error('FAIL:', message);
  }
}

// 1. Missing DATABASE_URL and DIRECT_URL
{
  const { status, stdout, stderr } = run({
    DATABASE_URL: undefined,
    DIRECT_URL: undefined
  });
  const combined = stdout + stderr;
  check(status !== 0, 'exits nonzero when DATABASE_URL and DIRECT_URL are missing');
  check(combined.includes('DATABASE_URL') && combined.includes('not set'), 'reports DATABASE_URL is not set');
}

// 2. Invalid DATABASE_URL
{
  const { status, stdout, stderr } = run({
    DATABASE_URL: 'not-a-valid-url',
    DIRECT_URL: 'postgresql://user:pass@localhost:99999/db'
  });
  const combined = stdout + stderr;
  check(status !== 0, 'exits nonzero when DATABASE_URL is invalid');
  check(combined.includes('not a valid PostgreSQL URL'), 'reports invalid DATABASE_URL URL');
}

// 3. .env file loading via DOTENV_CONFIG_PATH
{
  const tmpDir = mkdtempSync(join(tmpdir(), 'check-db-env-'));
  const envPath = join(tmpDir, 'test.env');
  writeFileSync(
    envPath,
    'DATABASE_URL=postgresql://user:pass@localhost:99999/db\nDIRECT_URL=postgresql://user:pass@localhost:99999/db\n'
  );

  const { status, stdout, stderr } = run({
    DATABASE_URL: undefined,
    DIRECT_URL: undefined,
    DOTENV_CONFIG_PATH: envPath
  });
  const combined = stdout + stderr;
  check(status !== 0, 'loads .env via DOTENV_CONFIG_PATH and exits nonzero for invalid URLs');
  check(combined.includes('not a valid PostgreSQL URL'), 'reports invalid URLs loaded from .env');
}

// 4. Valid DATABASE_URL + invalid DIRECT_URL
{
  const validDb = process.env.DATABASE_URL;
  if (!validDb) {
    console.log('SKIP: valid DATABASE_URL + invalid DIRECT_URL (set DATABASE_URL to run)');
  } else {
    const { status, stdout, stderr } = run({
      DATABASE_URL: validDb,
      DIRECT_URL: 'postgresql://user:pass@localhost:99999/db'
    });
    const combined = stdout + stderr;
    check(status !== 0, 'exits nonzero when DIRECT_URL is invalid even if DATABASE_URL is valid');
    check(combined.includes('DIRECT_URL'), 'reports DIRECT_URL failure');
  }
}

// 5. Valid DATABASE_URL + valid DIRECT_URL
{
  const validDb = process.env.DATABASE_URL;
  const validDirect = process.env.DIRECT_URL || validDb;
  if (!validDb || !validDirect) {
    console.log('SKIP: valid DATABASE_URL + valid DIRECT_URL (set both to run)');
  } else {
    const { status, stdout, stderr } = run({
      DATABASE_URL: validDb,
      DIRECT_URL: validDirect
    });
    const combined = stdout + stderr;
    check(status === 0, 'exits 0 when both DATABASE_URL and DIRECT_URL connect successfully');
    check(combined.includes('OK'), 'prints OK for both connections');
  }
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
