// Read-only: does every assigned resume resolve to a Drive file id, and does
// one of them actually stream? This is the check that would have caught the 500.
import prisma from '../src/prismaClient.js';
import { resolveResumeSource, extractDriveFileId } from '../src/utils/clientVisibility.js';
import { getFileStream } from '../src/services/google/drive.js';

const client = await prisma.talentPartnerClient.findFirst();
const { id: clientId, visibility } = client;
console.log(`client ${client.organization} visibility=${visibility}\n`);

const assignments = await prisma.clientResumeAssignment.findMany({
  where: { clientId, revokedAt: null },
  include: {
    application: { select: { id: true, resumeUrl: true, blindResumeUrl: true } },
    memberResume: { select: { id: true, storagePath: true } },
  },
});

let ok = 0;
const bad = [];
for (const a of assignments) {
  const source = resolveResumeSource(a, visibility);
  if (source) ok += 1;
  else bad.push(a.id);
}
console.log(`resolvable under ${visibility}: ${ok}/${assignments.length}`);
if (bad.length) console.log('unresolvable assignment ids:', bad.slice(0, 5));

// Same rows under BLIND, which reads a different column.
let blindOk = 0;
for (const a of assignments) if (resolveResumeSource(a, 'BLIND')) blindOk += 1;
console.log(`resolvable under BLIND:  ${blindOk}/${assignments.length}`);

// Both stored URL shapes must extract identically.
console.log('\nextractor spot-check:');
for (const v of [
  '/api/files/1JduFdD3X2R7GV4eMvxxwpbS3AP0qys5N/pdf',
  'https://uconsultingats.com/api/files/1CvCqDHXy_RqLDQLyeJ5VDl9abc/pdf',
  'https://drive.google.com/file/d/1abcDEF/view?usp=sharing',
  '1BareIdLooksLikeThis',
  '',
  null,
]) console.log(`  ${JSON.stringify(v)} -> ${JSON.stringify(extractDriveFileId(v))}`);

// The real thing: pull actual bytes from Drive for the first assignment.
const first = assignments.find((a) => resolveResumeSource(a, visibility));
const source = resolveResumeSource(first, visibility);
console.log(`\nstreaming assignment ${first.id} (fileId ${source.fileId}) ...`);
try {
  const stream = await getFileStream(source.fileId);
  let bytes = 0;
  await new Promise((resolve, reject) => {
    stream.on('data', (c) => { bytes += c.length; });
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  console.log(`  OK - ${bytes} bytes received from Drive`);
} catch (e) {
  console.error('  STREAM FAILED:', e.message);
}

await prisma.$disconnect();
