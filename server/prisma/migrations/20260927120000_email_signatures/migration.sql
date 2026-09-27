-- Named signatures for the automatic emails, and which one each email uses.
-- No table, or no row, means every email keeps its own sign-off.
--
-- Re-runnable: this is applied by hand with `prisma db execute`, which wraps
-- nothing in a transaction, so a half-applied file has to be safe to replay.

CREATE TABLE IF NOT EXISTS "email_signatures" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "imageUrl" TEXT,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_signatures_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "email_signatures_name_key"
    ON "email_signatures"("name");

-- At most one default. Two admins setting different defaults at once would
-- otherwise both succeed, and which one an email used would depend on row order.
CREATE UNIQUE INDEX IF NOT EXISTS "email_signatures_one_default"
    ON "email_signatures"("isDefault") WHERE "isDefault";

ALTER TABLE "email_template_style" ADD COLUMN IF NOT EXISTS "signatureId" TEXT;
