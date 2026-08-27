-- Distinguish what a client actually did, in the one table that records it.
--
-- Until now every row in client_resume_access_logs was a PDF fetch, and the only
-- way to tell a refused attempt from a successful one was that assignmentId
-- happened to be null. That was already thin, and CSV export makes it wrong:
-- an export writes one row per selected resume, which is indistinguishable from
-- the client having opened each of them.
--
-- Re-runnable, per the hand-apply flow in CLAUDE.md: the enum is created only if
-- absent, the column added only if absent, and the default backfills existing
-- rows as VIEW - which is what every row written before this migration was.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ClientAccessAction') THEN
        CREATE TYPE "ClientAccessAction" AS ENUM ('VIEW', 'VIEW_DENIED', 'EXPORT');
    END IF;
END
$$;

ALTER TABLE "client_resume_access_logs"
    ADD COLUMN IF NOT EXISTS "action" "ClientAccessAction" NOT NULL DEFAULT 'VIEW';

-- The admin-facing question is "what has this partner pulled out of the portal",
-- which reads by client and action over a time window.
CREATE INDEX IF NOT EXISTS "client_resume_access_logs_clientId_action_createdAt_idx"
    ON "client_resume_access_logs" ("clientId", "action", "createdAt");
