// End-to-end smoke for the portal's filter / sort / export surface, as the real
// CLIENT account against a running server.
//
//   node scripts/tpn-smoke-portal.mjs [port] [partner-email]
//
// Companion to tpn-smoke-client.mjs, which covers the list and the PDF proxy.
// This one covers what was added on top: /facets, the filter and sort params,
// and the CSV export.
//
// NOT read-only: an export writes one EXPORT row per resume into
// client_resume_access_logs, which is the point - the last section reads them
// back. Nothing else here writes.
//
// The visibility-dependent assertions are checked against whatever level the
// partner is on right now; flip it in the admin UI (Talent Pool -> the client ->
// Visibility) and re-run to cover the other levels.
import jwt from 'jsonwebtoken';
import prisma from '../src/prismaClient.js';
import config from '../src/config.js';

const base = `http://localhost:${process.argv[2] || '3001'}`;
const wantedEmail = process.argv[3];

// Deterministic on purpose. A bare findFirst() returns an arbitrary row once a
// second partner exists, so a run could silently report on a different client -
// and every visibility assertion below is read off whichever one it picked.
const partner = await prisma.talentPartnerClient.findFirst({
  where: wantedEmail ? { user: { email: wantedEmail } } : undefined,
  include: { user: { select: { id: true, email: true } } },
  orderBy: { createdAt: 'asc' },
});
if (!partner) {
  throw new Error(
    wantedEmail
      ? `no partner client with email ${wantedEmail}`
      : 'no partner client - create one in the admin Talent Pool page first'
  );
}

const partnerCount = await prisma.talentPartnerClient.count();
if (partnerCount > 1 && !wantedEmail) {
  console.log(
    `note: ${partnerCount} partner clients exist; testing the oldest. ` +
      'Pass an email as the second argument to pick another.\n'
  );
}

const token = jwt.sign({ userId: partner.user.id }, config.jwtSecret, { expiresIn: '5m' });
const auth = { Authorization: `Bearer ${token}` };
const visibility = partner.visibility;

const showsIdentity = visibility === 'BASIC' || visibility === 'FULL';
const showsContact = visibility === 'FULL';

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`     ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
};

const get = async (path) => {
  const res = await fetch(`${base}${path}`, { headers: auth });
  return { res, body: await res.json() };
};

console.log(`acting as CLIENT ${partner.user.email} (${partner.organization}, ${visibility})\n`);

// --- capabilities -----------------------------------------------------------
const { body: me } = await get('/api/client/me');
console.log(`GET /api/client/me`);
console.log(`     filterable: ${me.filterableFields?.join(', ')}`);
console.log(`     sortable:   ${me.sortableFields?.join(', ')}`);
check('gender filter matches visibility', me.filterableFields?.includes('gender') === showsIdentity);
check('gpa filter matches visibility', me.filterableFields?.includes('gpa') === showsContact);
check('name sort matches visibility', me.sortableFields?.includes('name') === showsIdentity);

// --- facets -----------------------------------------------------------------
const { body: facets } = await get('/api/client/facets');
console.log(`\nGET /api/client/facets`);
console.log(`     graduationYear: ${(facets.graduationYear || []).join(' ') || 'none'}`);
console.log(`     major:          ${(facets.major || []).slice(0, 6).join(' | ') || 'none'}`);
console.log(`     gender:         ${(facets.gender || []).join(' ') || '(absent)'}`);
check('gender facet matches visibility', Boolean(facets.gender) === showsIdentity);

// --- filtering --------------------------------------------------------------
const { body: all } = await get('/api/client/resumes?limit=100');
console.log(`\nGET /api/client/resumes  total=${all.total}`);

const year = facets.graduationYear?.[0];
if (year) {
  const { body: filtered } = await get(`/api/client/resumes?graduationYear=${year}&limit=100`);
  console.log(`\nGET /api/client/resumes?graduationYear=${year}  total=${filtered.total}`);
  check('filter narrows or equals the unfiltered total', filtered.total <= all.total);
  check(
    'every row matches the filter',
    filtered.items.every((i) => String(i.graduationYear).toLowerCase() === year.toLowerCase())
  );
}

// A BLIND client must not be able to filter by a field they cannot see - the
// server drops it rather than honouring it.
if (!showsIdentity) {
  const { body: gendered } = await get('/api/client/resumes?gender=Female&limit=100');
  check('gender filter is ignored under BLIND', gendered.total === all.total,
    `${gendered.total} vs ${all.total}`);
}

// --- sorting ----------------------------------------------------------------
const { body: asc } = await get('/api/client/resumes?sort=graduationYear&dir=asc&limit=100');
const { body: desc } = await get('/api/client/resumes?sort=graduationYear&dir=desc&limit=100');
const years = (page) => page.items.map((i) => i.graduationYear).filter(Boolean);
console.log(`\nGET /api/client/resumes?sort=graduationYear`);
console.log(`     asc:  ${years(asc).slice(0, 8).join(' ')}`);
console.log(`     desc: ${years(desc).slice(0, 8).join(' ')}`);
check('asc is non-decreasing', years(asc).every((y, i, a) => i === 0 || a[i - 1] <= y));
check('desc is non-increasing', years(desc).every((y, i, a) => i === 0 || a[i - 1] >= y));
check('blanks sort last in both directions',
  asc.items.findIndex((i) => !i.graduationYear) === -1 ||
  asc.items.findIndex((i) => !i.graduationYear) >= years(asc).length);

if (showsContact) {
  const { body: gpa } = await get('/api/client/resumes?sort=cumulativeGpa&dir=desc&limit=100');
  const values = gpa.items.map((i) => i.cumulativeGpa).filter(Boolean).map(Number);
  console.log(`     gpa desc: ${values.slice(0, 8).join(' ')}`);
  // The bug this catches: sorting a decimal column lexically puts 10.00 below 3.10.
  check('GPA sorts numerically', values.every((v, i, a) => i === 0 || a[i - 1] >= v));
}

// --- export -----------------------------------------------------------------
const ids = all.items.slice(0, 3).map((i) => i.assignmentId);
if (ids.length === 0) {
  console.log('\nno assignments to export - assign some in the admin Talent Pool page');
} else {
  const before = await prisma.clientResumeAccessLog.count({
    where: { clientId: partner.id, action: 'EXPORT' },
  });

  const res = await fetch(`${base}/api/client/resumes/export`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignmentIds: ids }),
  });

  // Read the raw bytes, not res.text(). The WHATWG fetch spec strips a leading
  // BOM when decoding UTF-8, so asserting on the decoded string would report a
  // missing BOM even when it is on the wire - which is exactly what Excel reads.
  const raw = Buffer.from(await res.arrayBuffer());
  const csv = raw.toString('utf8');

  console.log(`\n${res.status}  POST /api/client/resumes/export  (${ids.length} ids)`);
  console.log(`     content-type: ${res.headers.get('content-type')}`);
  console.log(`     disposition:  ${res.headers.get('content-disposition')}`);
  console.log(`     nosniff:      ${res.headers.get('x-content-type-options')}`);
  console.log(`\n${csv.split('\r\n').slice(0, 4).join('\n')}\n`);

  check('status 200', res.status === 200);
  check('leads with a UTF-8 BOM on the wire',
    raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf,
    [...raw.subarray(0, 3)].map((b) => b.toString(16).padStart(2, '0')).join(' '));
  check('rows separated by CRLF', csv.includes('\r\n'));
  check('one header + one row per id', csv.trim().split('\r\n').length === ids.length + 1);

  const header = csv.trim().split('\r\n')[0];
  check('name columns match visibility', header.includes('First Name') === showsIdentity);
  check('contact columns match visibility', header.includes('Email') === showsContact);
  check('GPA column matches visibility', header.includes('Cumulative GPA') === showsContact);

  // The whole point of the export being metadata-only.
  for (const needle of ['/api/files/', 'drive.google.com', 'storagePath', 'studentId', '.pdf']) {
    check(`no ${needle}`, !csv.includes(needle));
  }

  // A formula-injection cell would start with a bare =, + or @ after a comma.
  check('no unescaped formula cell', !/(^|,)[=+@]/m.test(csv));

  const after = await prisma.clientResumeAccessLog.count({
    where: { clientId: partner.id, action: 'EXPORT' },
  });
  check('one EXPORT log row per exported resume', after - before === ids.length,
    `wrote ${after - before}`);

  // Caps and refusals.
  const empty = await fetch(`${base}/api/client/resumes/export`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignmentIds: [] }),
  });
  check('empty selection refused with 400', empty.status === 400);

  const tooMany = await fetch(`${base}/api/client/resumes/export`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignmentIds: Array.from({ length: 1001 }, (_, i) => `x-${i}`) }),
  });
  check('over-cap selection refused with 400', tooMany.status === 400);

  const borrowed = await fetch(`${base}/api/client/resumes/export`, {
    method: 'POST',
    headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ assignmentIds: ['00000000-0000-0000-0000-000000000000'] }),
  });
  check('an id this client does not own exports nothing (404)', borrowed.status === 404);
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
await prisma.$disconnect();
process.exit(failures === 0 ? 0 : 1);
