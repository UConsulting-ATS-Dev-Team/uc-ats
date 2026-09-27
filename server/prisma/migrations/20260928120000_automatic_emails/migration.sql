-- Automatic emails an admin writes, and one row per person each one fired for.
-- Additive only. No table means no custom emails, and the runner does nothing.
--
-- Re-runnable: this is applied by hand with `prisma db execute`, which wraps
-- nothing in a transaction, so a half-applied file has to be safe to replay.

CREATE TABLE IF NOT EXISTS "automatic_emails" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "enabledAt" TIMESTAMP(3),
    "trigger" TEXT NOT NULL,
    "triggerConfig" JSONB NOT NULL DEFAULT '{}',
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "marketing" BOOLEAN NOT NULL DEFAULT false,
    "format" TEXT NOT NULL DEFAULT 'DESIGNED',
    "banner" TEXT NOT NULL DEFAULT 'brand',
    "signatureId" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automatic_emails_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "automatic_email_sends" (
    "id" TEXT NOT NULL,
    "automaticEmailId" TEXT NOT NULL,
    "subjectKey" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "automatic_email_sends_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "automatic_email_sends_automaticEmailId_subjectKey_key"
    ON "automatic_email_sends"("automaticEmailId", "subjectKey");

CREATE INDEX IF NOT EXISTS "automatic_email_sends_automaticEmailId_status_idx"
    ON "automatic_email_sends"("automaticEmailId", "status");

DO $$ BEGIN
    ALTER TABLE "automatic_email_sends"
        ADD CONSTRAINT "automatic_email_sends_automaticEmailId_fkey"
        FOREIGN KEY ("automaticEmailId") REFERENCES "automatic_emails"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
