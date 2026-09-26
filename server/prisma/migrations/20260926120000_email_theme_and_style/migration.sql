-- How the automatic emails look: one theme row, plus per-email overrides.
-- No row, or no table, means the look the code ships - the send path falls
-- back to it rather than failing, so a deploy can reach a send before anyone
-- has run this.
--
-- Re-runnable: this is applied by hand with `prisma db execute`, which wraps
-- nothing in a transaction, so a half-applied file has to be safe to replay.

CREATE TABLE IF NOT EXISTS "email_theme" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "brandName" TEXT,
    "logoUrl" TEXT,
    "headerBackground" TEXT,
    "headerTextColor" TEXT,
    "accentColor" TEXT,
    "fontFamily" TEXT,
    "footerText" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_theme_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "email_template_style" (
    "id" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "format" TEXT,
    "banner" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "email_template_style_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "email_template_style_templateKey_key"
    ON "email_template_style"("templateKey");
