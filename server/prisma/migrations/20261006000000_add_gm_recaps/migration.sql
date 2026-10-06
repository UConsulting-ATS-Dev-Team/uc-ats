-- Weekly general meeting recaps (GM Recaps, behind executive access).
-- Re-runnable: applied by hand with `prisma db execute` while DIRECT_URL is broken.
CREATE TABLE IF NOT EXISTS "gm_recaps" (
    "id" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "headerImageUrl" TEXT,
    "photoUrl" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "messageLogId" TEXT,
    "recipientCount" INTEGER,
    "sentCount" INTEGER,
    "failedCount" INTEGER,
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "scheduledById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "gm_recaps_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "gm_recaps_status_scheduledAt_idx" ON "gm_recaps"("status", "scheduledAt");
CREATE INDEX IF NOT EXISTS "gm_recaps_createdAt_idx" ON "gm_recaps"("createdAt");
