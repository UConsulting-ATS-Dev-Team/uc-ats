-- Master Communications: unsubscribes and saved audiences.
--
-- Re-runnable: this is applied by hand with `prisma db execute`, which wraps
-- nothing in a transaction, so a half-applied file has to be safe to replay.

-- Addresses held back from marketing sends -------------------------------------

CREATE TABLE IF NOT EXISTS "email_suppressions" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "detail" TEXT,
    "messageLogId" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "resubscribedAt" TIMESTAMP(3),

    CONSTRAINT "email_suppressions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "email_suppressions_email_key"
    ON "email_suppressions"("email");
CREATE INDEX IF NOT EXISTS "email_suppressions_resubscribedAt_idx"
    ON "email_suppressions"("resubscribedAt");

-- Saved audiences ---------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "saved_audiences" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "filters" JSONB NOT NULL,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "lastUsedCount" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "saved_audiences_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "saved_audiences_updatedAt_idx" ON "saved_audiences"("updatedAt");

ALTER TABLE "saved_audiences" DROP CONSTRAINT IF EXISTS "saved_audiences_createdById_fkey";
ALTER TABLE "saved_audiences" ADD CONSTRAINT "saved_audiences_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "saved_audiences" DROP CONSTRAINT IF EXISTS "saved_audiences_updatedById_fkey";
ALTER TABLE "saved_audiences" ADD CONSTRAINT "saved_audiences_updatedById_fkey"
    FOREIGN KEY ("updatedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Drafts and schedules can point at one -----------------------------------------

ALTER TABLE "message_drafts" ADD COLUMN IF NOT EXISTS "savedAudienceId" TEXT;
ALTER TABLE "message_drafts" DROP CONSTRAINT IF EXISTS "message_drafts_savedAudienceId_fkey";
ALTER TABLE "message_drafts" ADD CONSTRAINT "message_drafts_savedAudienceId_fkey"
    FOREIGN KEY ("savedAudienceId") REFERENCES "saved_audiences"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "message_schedules" ADD COLUMN IF NOT EXISTS "savedAudienceId" TEXT;
ALTER TABLE "message_schedules" DROP CONSTRAINT IF EXISTS "message_schedules_savedAudienceId_fkey";
ALTER TABLE "message_schedules" ADD CONSTRAINT "message_schedules_savedAudienceId_fkey"
    FOREIGN KEY ("savedAudienceId") REFERENCES "saved_audiences"("id") ON DELETE SET NULL ON UPDATE CASCADE;
