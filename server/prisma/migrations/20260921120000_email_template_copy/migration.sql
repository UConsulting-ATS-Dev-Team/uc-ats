-- Admin-editable wording for the automatic emails, one row per template that
-- somebody has actually changed. No row means the email reads the way the code
-- ships it, which is also what Reset restores by deleting the row.
--
-- Re-runnable: this is applied by hand with `prisma db execute`, which wraps
-- nothing in a transaction, so a half-applied file has to be safe to replay.

CREATE TABLE IF NOT EXISTS "email_template_copy" (
    "id" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "copy" JSONB NOT NULL DEFAULT '{}',
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_template_copy_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "email_template_copy_templateKey_key"
    ON "email_template_copy"("templateKey");
