// Applies the Talent Partner Network migrations using the session pooler.
//
// `prisma migrate dev` / `migrate deploy` authenticate with DIRECT_URL, whose
// password is stale in this repo (see CLAUDE.md). This script does what
// CLAUDE.md documents by hand: rebuild DATABASE_URL on port 5432 (session mode,
// not the 6543 transaction pooler the CLI cannot use), run each migration file,
// then record it so a future `migrate deploy` does not replay it.
//
// Both migration files are written to be re-runnable, so running this twice is
// safe.
//
//   node scripts/apply-tpn-migrations.mjs          # apply
//   node scripts/apply-tpn-migrations.mjs --check  # connectivity + state only

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const serverDir = path.join(__dirname, '..');
const prismaCli = path.join(serverDir, 'node_modules', 'prisma', 'build', 'index.js');

const MIGRATIONS = [
  '20260825130000_add_client_user_role',
  '20260825130100_add_client_resume_portal',
];

function sessionUrl() {
  const env = fs.readFileSync(path.join(serverDir, '.env'), 'utf8');
  const match = env.match(/^DATABASE_URL=(.*)$/m);
  if (!match) throw new Error('DATABASE_URL not found in server/.env');
  const raw = match[1].trim().replace(/^["']|["']$/g, '');
  const url = new URL(raw);
  url.port = '5432';
  return url.toString();
}

function run(args, env = {}) {
  return execFileSync(process.execPath, [prismaCli, ...args], {
    cwd: serverDir,
    env: { ...process.env, ...env },
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

const url = sessionUrl();
const check = process.argv.includes('--check');

const probePath = path.join(serverDir, '.tpn-probe.sql');

if (check) {
  fs.writeFileSync(
    probePath,
    "SELECT to_regclass('public.talent_partner_clients') IS NOT NULL AS portal_tables_exist;\n"
  );
  try {
    console.log(run(['db', 'execute', '--url', url, '--file', probePath]));
    console.log('Connectivity OK via session pooler (port 5432).');
  } finally {
    fs.rmSync(probePath, { force: true });
  }
  process.exit(0);
}

for (const name of MIGRATIONS) {
  const file = path.join(serverDir, 'prisma', 'migrations', name, 'migration.sql');
  console.log(`\n--- applying ${name}`);
  console.log(run(['db', 'execute', '--url', url, '--file', file]));
  console.log(`--- recording ${name}`);
  console.log(run(['migrate', 'resolve', '--applied', name], { DIRECT_URL: url }));
}

console.log('\nDone. Run `npx prisma generate` if the client is not already current.');
