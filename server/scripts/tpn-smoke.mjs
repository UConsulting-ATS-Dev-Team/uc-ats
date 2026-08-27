// Read-only smoke test against a running server. Mints a short-lived admin JWT
// locally (same secret the server uses) and exercises the GET endpoints.
// Writes nothing.
//
//   node scripts/tpn-smoke.mjs [port]
import jwt from 'jsonwebtoken';
import prisma from '../src/prismaClient.js';
import config from '../src/config.js';

const port = process.argv[2] || '3001';
const base = `http://localhost:${port}`;

const admin = await prisma.user.findFirst({
  where: { role: 'ADMIN', isActive: true },
  select: { id: true, email: true },
});
if (!admin) throw new Error('No active ADMIN user found');

const token = jwt.sign({ userId: admin.id }, config.jwtSecret, { expiresIn: '5m' });
const auth = { Authorization: `Bearer ${token}` };

const show = async (label, path, init = {}) => {
  const res = await fetch(`${base}${path}`, { ...init, headers: { ...auth, ...(init.headers || {}) } });
  let body = '';
  try {
    body = JSON.stringify(await res.json()).slice(0, 220);
  } catch {
    body = '(non-JSON)';
  }
  console.log(`${String(res.status).padEnd(4)} ${label}\n     ${body}\n`);
  return res;
};

console.log(`\nActing as admin: ${admin.email}\n`);

await show('GET  /api/admin/talent-pool/clients', '/api/admin/talent-pool/clients');
await show('GET  /api/admin/talent-pool/filter-fields', '/api/admin/talent-pool/filter-fields');
await show('GET  /api/admin/talent-pool/stats  (registeredClients should be a number now)', '/api/admin/talent-pool/stats');

console.log('--- an ADMIN must NOT reach the client portal ---');
await show('GET  /api/client/resumes  (expect 403)', '/api/client/resumes');

console.log('--- preview refuses an empty filter rather than matching everything ---');
await show(
  'POST /api/admin/talent-pool/clients/does-not-exist/preview  (expect 404)',
  '/api/admin/talent-pool/clients/does-not-exist/preview',
  { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filter: { rows: [] } }) }
);

await prisma.$disconnect();
