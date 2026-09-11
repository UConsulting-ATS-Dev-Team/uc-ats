#!/usr/bin/env node
// Set or replace the executive-committee password that unseals recruiting records.
//
//   cd server && node scripts/set-exec-password.js
//
// This is the only way to set the first password - changing it in the app needs
// the current one. The password is prompted for twice with input hidden, and is
// never read from argv or the environment, so it does not land in shell history.

import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config as loadEnv } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: join(__dirname, '..', '.env') });

// Imported after .env is loaded: config.js throws without JWT_SECRET, and the
// Prisma client reads DATABASE_URL when it is constructed.
const { default: prisma } = await import('../src/prismaClient.js');
const { isExecPasswordConfigured, setExecPassword, validateNewExecPassword } = await import('../src/services/execAccess.js');

function promptHidden(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const writeToOutput = rl._writeToOutput.bind(rl);
    let muted = false;
    rl._writeToOutput = (chunk) => {
      if (!muted) writeToOutput(chunk);
    };
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    // The prompt itself was written synchronously above; mute only what is typed.
    muted = true;
  });
}

async function main() {
  if (!process.stdin.isTTY) {
    console.error('Run this from an interactive terminal so the password can be typed without echo.');
    process.exitCode = 1;
    return;
  }

  console.log((await isExecPasswordConfigured())
    ? 'An executive password is already set. Continuing replaces it.'
    : 'No executive password is set yet.');

  const password = await promptHidden('New executive password: ');
  const problem = validateNewExecPassword(password);
  if (problem) {
    console.error(problem);
    process.exitCode = 1;
    return;
  }

  const confirmation = await promptHidden('Type it again: ');
  if (confirmation !== password) {
    console.error('The two entries did not match. Nothing changed.');
    process.exitCode = 1;
    return;
  }

  await setExecPassword(password);
  console.log('Executive password saved. Share it only with the executive committee.');
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
