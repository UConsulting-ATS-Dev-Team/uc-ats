-- Audience-scoped cycle activation.
--
-- `isActive` keeps its meaning: the cycle members, candidates and the public pages
-- see. `isAdminActive` is the new, independent pointer for admins. They are normally
-- the same row and differ only during a handover, where admins finish out the closing
-- cycle while the next one opens to candidates.
--
-- Purely additive: one column and one index. No drops, renames, type changes or
-- backfills. On PostgreSQL 11+ an ADD COLUMN with a non-volatile DEFAULT is
-- metadata-only, so this does not rewrite the table.
--
-- Written to be re-runnable: `prisma db execute` has no transaction wrapper of its
-- own (see CLAUDE.md), so a half-applied file has to be safe to run again.

ALTER TABLE "recruiting_cycles"
  ADD COLUMN IF NOT EXISTS "isAdminActive" BOOLEAN NOT NULL DEFAULT false;

-- Fail loudly rather than letting CREATE UNIQUE INDEX report a bare duplicate-key
-- error. Only reachable on a re-run after someone hand-set the column.
DO $$
DECLARE offenders TEXT;
BEGIN
  SELECT string_agg("name", ', ') INTO offenders
    FROM "recruiting_cycles" WHERE "isAdminActive";
  IF (SELECT COUNT(*) FROM "recruiting_cycles" WHERE "isAdminActive") > 1 THEN
    RAISE EXCEPTION
      'Cannot enforce a single admin-active cycle: clear isAdminActive on all but one of: %',
      offenders;
  END IF;
END $$;

-- Mirrors `recruiting_cycles_single_active` from the
-- 20260808210000_cycle_bootstrap_identity_and_single_active migration.
DROP INDEX IF EXISTS "recruiting_cycles_single_admin_active";
CREATE UNIQUE INDEX "recruiting_cycles_single_admin_active"
  ON "recruiting_cycles" (("isAdminActive")) WHERE "isAdminActive";
