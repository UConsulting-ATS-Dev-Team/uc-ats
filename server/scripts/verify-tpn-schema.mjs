// Reads back what the TPN migrations created, using the Prisma client (which
// returns rows, unlike `prisma db execute`).
import prisma from '../src/prismaClient.js';

const rows = await prisma.$queryRaw`
  SELECT
    (SELECT count(*) FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'UserRole' AND e.enumlabel = 'CLIENT')::int  AS client_role,
    (SELECT count(*) FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('talent_partner_clients','member_resumes',
                           'client_assignment_batches','client_resume_assignments',
                           'client_resume_access_logs'))::int         AS portal_tables,
    (SELECT count(*) FROM pg_indexes
      WHERE schemaname = 'public'
        AND indexname IN ('member_resumes_memberId_current_key',
                          'client_resume_assignments_client_app_live_key',
                          'client_resume_assignments_client_member_live_key'))::int AS partial_unique_indexes,
    (SELECT count(*) FROM pg_constraint
      WHERE conname = 'client_resume_assignments_one_target')::int    AS check_constraint
`;

console.log(rows[0]);

const expected = { client_role: 1, portal_tables: 5, partial_unique_indexes: 3, check_constraint: 1 };
const actual = rows[0];
const bad = Object.entries(expected).filter(([k, v]) => Number(actual[k]) !== v);

if (bad.length) {
  console.error('MISMATCH:', bad.map(([k, v]) => `${k} expected ${v}, got ${actual[k]}`).join('; '));
  process.exit(1);
}
console.log('All TPN schema objects present.');
await prisma.$disconnect();
