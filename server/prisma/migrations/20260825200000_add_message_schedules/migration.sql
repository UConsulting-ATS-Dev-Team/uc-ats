CREATE TABLE IF NOT EXISTS "message_schedules" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "audience" TEXT NOT NULL,
    "filters" JSONB NOT NULL DEFAULT '{}',
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "cycleId" TEXT,
    "templateId" TEXT,
    "sentBy" TEXT NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "messageLogId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "message_schedules_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "message_schedules_scheduledAt_idx" ON "message_schedules"("scheduledAt");
CREATE INDEX IF NOT EXISTS "message_schedules_status_idx" ON "message_schedules"("status");
CREATE INDEX IF NOT EXISTS "message_schedules_cycleId_idx" ON "message_schedules"("cycleId");

ALTER TABLE "message_schedules" DROP CONSTRAINT IF EXISTS "message_schedules_templateId_fkey";
ALTER TABLE "message_schedules" ADD CONSTRAINT "message_schedules_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "message_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "message_schedules" DROP CONSTRAINT IF EXISTS "message_schedules_cycleId_fkey";
ALTER TABLE "message_schedules" ADD CONSTRAINT "message_schedules_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "recruiting_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "message_schedules" DROP CONSTRAINT IF EXISTS "message_schedules_sentBy_fkey";
ALTER TABLE "message_schedules" ADD CONSTRAINT "message_schedules_sentBy_fkey" FOREIGN KEY ("sentBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "message_schedules" DROP CONSTRAINT IF EXISTS "message_schedules_messageLogId_fkey";
ALTER TABLE "message_schedules" ADD CONSTRAINT "message_schedules_messageLogId_fkey" FOREIGN KEY ("messageLogId") REFERENCES "message_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
