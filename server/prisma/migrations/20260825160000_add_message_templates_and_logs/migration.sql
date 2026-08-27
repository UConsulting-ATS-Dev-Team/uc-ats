CREATE TABLE IF NOT EXISTS "message_templates" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "message_templates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "message_logs" (
    "id" TEXT NOT NULL,
    "templateId" TEXT,
    "channel" TEXT NOT NULL,
    "recipientCount" INTEGER NOT NULL,
    "subject" TEXT,
    "body" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentBy" TEXT NOT NULL,
    "cycleId" TEXT,
    CONSTRAINT "message_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "message_templates_cycleId_idx" ON "message_templates"("cycleId");
CREATE INDEX IF NOT EXISTS "message_logs_cycleId_idx" ON "message_logs"("cycleId");
CREATE INDEX IF NOT EXISTS "message_logs_sentAt_idx" ON "message_logs"("sentAt");

ALTER TABLE "message_templates" DROP CONSTRAINT IF EXISTS "message_templates_cycleId_fkey";
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "recruiting_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "message_templates" DROP CONSTRAINT IF EXISTS "message_templates_createdBy_fkey";
ALTER TABLE "message_templates" ADD CONSTRAINT "message_templates_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "message_logs" DROP CONSTRAINT IF EXISTS "message_logs_templateId_fkey";
ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "message_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "message_logs" DROP CONSTRAINT IF EXISTS "message_logs_cycleId_fkey";
ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "recruiting_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "message_logs" DROP CONSTRAINT IF EXISTS "message_logs_sentBy_fkey";
ALTER TABLE "message_logs" ADD CONSTRAINT "message_logs_sentBy_fkey" FOREIGN KEY ("sentBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
