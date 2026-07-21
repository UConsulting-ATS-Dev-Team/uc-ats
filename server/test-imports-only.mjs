console.log('1. Script started at', new Date().toISOString());

const t0 = Date.now();
const { google } = await import('googleapis');
console.log(`2. "googleapis" imported OK in ${Date.now() - t0}ms`);

const t1 = Date.now();
const { getGoogleAuthClient } = await import('./src/services/google/auth.js');
console.log(`3. "auth.js" imported OK in ${Date.now() - t1}ms`);

const t2 = Date.now();
const configMod = await import('./src/config.js');
console.log(`4. "config.js" imported OK in ${Date.now() - t2}ms`);
console.log('   config.googleCalendarId =', configMod.default.googleCalendarId);

console.log('5. All imports succeeded — no network calls made yet. Script exiting.');
process.exit(0);
