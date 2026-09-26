import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const HELP_TEXT = `Move profile images off the server's disk and into Supabase Storage.

Every User.profileImage that still points at /api/uploads/profile-images/ is
either uploaded to the profile-images bucket (when the file is in this
checkout, which is true of the committed team-page photos) or cleared (when
the file is gone, which is true of anything uploaded through the app before
this change). A cleared row shows initials instead of a broken image, and the
person can upload again.

Usage: node scripts/migrate-profile-images-to-storage.js [--apply]

Options:
  --apply     Upload and write rows (default is a dry run that changes nothing).
  -h, --help  Show this help message.
`;

const LOCAL_URL_PREFIX = '/api/uploads/profile-images/';

/**
 * Decide what happens to each row. Pure, so it can be tested without a
 * database or a bucket.
 *
 * @param {{id: string, fullName: string, profileImage: string|null}[]} users
 * @param {(fileName: string) => boolean} fileExists
 */
export function planMigration(users, fileExists) {
  const plan = { upload: [], clear: [], skip: [] };
  for (const user of users) {
    const url = user.profileImage;
    if (!url || !url.startsWith(LOCAL_URL_PREFIX)) {
      plan.skip.push(user);
      continue;
    }
    const fileName = url.slice(LOCAL_URL_PREFIX.length);
    // A name that tries to step out of the directory is treated as missing.
    if (fileName.includes('/') || fileName.includes('..') || !fileExists(fileName)) {
      plan.clear.push(user);
    } else {
      plan.upload.push({ ...user, fileName });
    }
  }
  return plan;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('-h') || args.includes('--help')) {
    console.log(HELP_TEXT);
    process.exit(0);
  }
  const apply = args.includes('--apply');

  const { default: prisma } = await import('../src/prismaClient.js');
  const { isSupabaseAvailable } = await import('../src/supabaseClient.js');
  const { storeProfileImage, removeProfileImage, LOCAL_UPLOAD_DIR } = await import(
    '../src/services/profileImageStorage.js'
  );

  if (apply && !isSupabaseAvailable()) {
    // storeProfileImage would fall back to the local disk, which is the thing
    // this script exists to move away from.
    console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set to run with --apply.');
    process.exit(1);
  }

  const users = await prisma.user.findMany({
    where: { profileImage: { startsWith: LOCAL_URL_PREFIX } },
    select: { id: true, fullName: true, profileImage: true },
    orderBy: { fullName: 'asc' },
  });
  const plan = planMigration(users, (name) => fs.existsSync(path.join(LOCAL_UPLOAD_DIR, name)));

  console.log(`${apply ? 'APPLY' : 'DRY RUN'}: ${users.length} rows point at the local disk`);
  console.log(`  upload to storage: ${plan.upload.length}`);
  console.log(`  file missing, clear: ${plan.clear.length}`);
  for (const user of plan.clear) console.log(`    - ${user.fullName} (${user.profileImage})`);

  if (!apply) {
    await prisma.$disconnect();
    return;
  }

  let uploaded = 0;
  let cleared = 0;
  let skipped = 0;
  let failed = 0;
  for (const user of plan.upload) {
    try {
      const buffer = fs.readFileSync(path.join(LOCAL_UPLOAD_DIR, user.fileName));
      const url = await storeProfileImage(user.id, buffer);
      // Conditional on the old value, so a person who uploads a new image
      // while this runs keeps theirs. The copy made here is then unused.
      const { count } = await prisma.user.updateMany({
        where: { id: user.id, profileImage: user.profileImage },
        data: { profileImage: url },
      });
      if (count === 0) {
        await removeProfileImage(url);
        skipped += 1;
        console.log(`  skipped ${user.fullName}: image changed during the run`);
      } else {
        uploaded += 1;
        console.log(`  uploaded ${user.fullName}`);
      }
    } catch (error) {
      failed += 1;
      console.error(`  FAILED ${user.fullName}: ${error.message}`);
    }
  }
  for (const user of plan.clear) {
    const { count } = await prisma.user.updateMany({
      where: { id: user.id, profileImage: user.profileImage },
      data: { profileImage: null },
    });
    if (count === 0) skipped += 1;
    else cleared += 1;
  }
  console.log(
    `Done. ${uploaded} uploaded, ${cleared} cleared, ${skipped} skipped (image changed during the run), ${failed} failed.`
  );
  console.log('Signed-in users see the change within 5 minutes (user cache TTL).');

  await prisma.$disconnect();
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
