-- Unsent master communications, saved so one can be finished later or by
-- someone else. Re-runnable: applied with `prisma db execute`, which has no
-- transaction of its own (see CLAUDE.md).

CREATE TABLE IF NOT EXISTS "message_drafts" (
  "id"          TEXT NOT NULL,
  "name"        TEXT NOT NULL,
  "channel"     TEXT NOT NULL,
  "audience"    TEXT NOT NULL,
  "filters"     JSONB,
  "subject"     TEXT NOT NULL DEFAULT '',
  "body"        TEXT NOT NULL,
  "cycleId"     TEXT,
  "createdById" TEXT NOT NULL,
  "updatedById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "message_drafts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "message_drafts_cycleId_idx" ON "message_drafts"("cycleId");
-- The list is ordered by most recently touched, so this covers it.
CREATE INDEX IF NOT EXISTS "message_drafts_updatedAt_idx" ON "message_drafts"("updatedAt");

-- ADD CONSTRAINT has no IF NOT EXISTS form, hence the guards.
DO $$
BEGIN
  ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_cycleId_fkey"
    FOREIGN KEY ("cycleId") REFERENCES "recruiting_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
