// Read-only end-to-end smoke as the real CLIENT account against a running
// server: list, then actually pull a PDF through the portal's proxy route.
//
//   node scripts/tpn-smoke-client.mjs [port]
import jwt from 'jsonwebtoken';
import prisma from '../src/prismaClient.js';
import config from '../src/config.js';

const base = `http://localhost:${process.argv[2] || '3001'}`;

const partner = await prisma.talentPartnerClient.findFirst({
  include: { user: { select: { id: true, email: true } } },
});
if (!partner) throw new Error('no partner client');

const token = jwt.sign({ userId: partner.user.id }, config.jwtSecret, { expiresIn: '5m' });
const auth = { Authorization: `Bearer ${token}` };
console.log(`acting as CLIENT ${partner.user.email} (${partner.organization}, ${partner.visibility})\n`);

const me = await fetch(`${base}/api/client/me`, { headers: auth });
console.log(`${me.status}  GET /api/client/me\n     ${JSON.stringify(await me.json())}\n`);

const list = await fetch(`${base}/api/client/resumes?limit=3`, { headers: auth });
const page = await list.json();
console.log(`${list.status}  GET /api/client/resumes?limit=3`);
console.log(`     total=${page.total} items=${page.items?.length}`);
console.log(`     first: ${JSON.stringify(page.items?.[0])}\n`);

const serialized = JSON.stringify(page);
for (const needle of ['/api/files/', 'drive.google.com', 'storagePath', 'studentId']) {
  console.log(`     leak check ${needle.padEnd(18)} ${serialized.includes(needle) ? 'FOUND - BAD' : 'clean'}`);
}

const first = page.items?.[0];
if (first) {
  const pdf = await fetch(`${base}${first.pdfUrl}`, { headers: auth });
  const buf = Buffer.from(await pdf.arrayBuffer());
  console.log(`\n${pdf.status}  GET ${first.pdfUrl}`);
  console.log(`     content-type: ${pdf.headers.get('content-type')}`);
  console.log(`     disposition:  ${pdf.headers.get('content-disposition')}`);
  console.log(`     cache:        ${pdf.headers.get('cache-control')}`);
  console.log(`     bytes: ${buf.length}  starts with %PDF: ${buf.subarray(0, 4).toString() === '%PDF'}`);
}

const bogus = await fetch(`${base}/api/client/resumes/00000000-0000-0000-0000-000000000000/pdf`, { headers: auth });
console.log(`\n${bogus.status}  GET /pdf for an id this client does not own (expect 404)`);

const contained = await fetch(`${base}/api/users`, { headers: auth });
console.log(`${contained.status}  GET /api/users as CLIENT (expect 403)`);

await prisma.$disconnect();
