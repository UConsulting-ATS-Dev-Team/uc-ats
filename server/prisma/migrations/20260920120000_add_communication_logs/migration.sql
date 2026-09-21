-- One row per recipient per outbound message, written at every send chokepoint.
-- Re-runnable: `prisma db execute` applies this file without a transaction of its
-- own (see CLAUDE.md), so a half-applied run has to be safe to replay.

CREATE TABLE IF NOT EXISTS "communication_logs" (
    "id"                  TEXT         NOT NULL,
    "channel"             TEXT         NOT NULL DEFAULT 'email',
    "category"            TEXT         NOT NULL DEFAULT 'OTHER',
    "trigger"             TEXT         NOT NULL DEFAULT 'AUTOMATED',
    "status"              TEXT         NOT NULL DEFAULT 'SENT',
    "recipient"           TEXT         NOT NULL,
    "recipientName"       TEXT,
    "subject"             TEXT,
    "bodyPreview"         TEXT,
    "error"               TEXT,
    "providerMessageId"   TEXT,
    "hasAttachments"      BOOLEAN      NOT NULL DEFAULT false,
    "triggeredById"       TEXT,
    "messageLogId"        TEXT,
    "cycleId"             TEXT,
    "sentAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "communication_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "communication_logs_sentAt_idx"       ON "communication_logs"("sentAt");
CREATE INDEX IF NOT EXISTS "communication_logs_recipient_idx"    ON "communication_logs"("recipient");
CREATE INDEX IF NOT EXISTS "communication_logs_category_idx"     ON "communication_logs"("category");
CREATE INDEX IF NOT EXISTS "communication_logs_channel_idx"      ON "communication_logs"("channel");
CREATE INDEX IF NOT EXISTS "communication_logs_status_idx"       ON "communication_logs"("status");
CREATE INDEX IF NOT EXISTS "communication_logs_cycleId_idx"      ON "communication_logs"("cycleId");
CREATE INDEX IF NOT EXISTS "communication_logs_messageLogId_idx" ON "communication_logs"("messageLogId");

-- ADD CONSTRAINT has no IF NOT EXISTS, so each foreign key is guarded by name.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'communication_logs_triggeredById_fkey') THEN
        ALTER TABLE "communication_logs"
            ADD CONSTRAINT "communication_logs_triggeredById_fkey"
            FOREIGN KEY ("triggeredById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'communication_logs_messageLogId_fkey') THEN
        ALTER TABLE "communication_logs"
            ADD CONSTRAINT "communication_logs_messageLogId_fkey"
            FOREIGN KEY ("messageLogId") REFERENCES "message_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'communication_logs_cycleId_fkey') THEN
        ALTER TABLE "communication_logs"
            ADD CONSTRAINT "communication_logs_cycleId_fkey"
            FOREIGN KEY ("cycleId") REFERENCES "recruiting_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END
$$;
