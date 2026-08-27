-- Talent Partner Network: the client role.
--
-- The TPN page already had a "Registered clients" stat card whose placeholder
-- read "There is no client user role yet - accounts are USER, MEMBER, or ADMIN."
-- This is that role. A CLIENT reaches only /api/client/* - see
-- src/middleware/externalContainment.js.
--
-- Alone in its own migration on purpose: PostgreSQL forbids *using* a newly
-- added enum value in the same transaction that added it. Nothing in the
-- companion migration references the literal 'CLIENT', so one combined file
-- would work today - but `prisma db execute` wraps a file in an implicit
-- transaction and `prisma migrate deploy` in an explicit one, so the moment
-- anyone adds a `WHERE role = 'CLIENT'` backfill here it would break in a way
-- that is annoying to diagnose. Splitting costs nothing.

ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'CLIENT';
