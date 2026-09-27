-- SES open and click events, for Site Analytics' Email tab. Written by
-- services/sesEvents.js from the same SNS webhook that already carries
-- deliveries and bounces. Nothing reads it on a path that must succeed.
--
-- Re-runnable: this is applied by hand with `prisma db execute`, which wraps
-- nothing in a transaction, so a half-applied file has to be safe to replay.

CREATE TABLE IF NOT EXISTS "email_engagement_events" (
    "id" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "communicationLogId" TEXT,
    "sesMessageId" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "category" TEXT,
    "link" TEXT,
    "userAgent" TEXT,
    "ip" TEXT,
    "suspectedBot" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "email_engagement_events_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "email_engagement_events_at_idx" ON "email_engagement_events"("at");
CREATE INDEX IF NOT EXISTS "email_engagement_events_communicationLogId_idx" ON "email_engagement_events"("communicationLogId");
CREATE INDEX IF NOT EXISTS "email_engagement_events_category_at_idx" ON "email_engagement_events"("category", "at");
