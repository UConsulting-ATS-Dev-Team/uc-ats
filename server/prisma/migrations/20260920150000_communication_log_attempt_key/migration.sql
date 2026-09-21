-- Identifies one message to one recipient across retries, so a transient
-- failure updates its row instead of leaving a FAILED row beside the SENT one.
-- Re-runnable, like every migration applied by hand here.

ALTER TABLE "communication_logs" ADD COLUMN IF NOT EXISTS "attemptKey" TEXT;

-- Null is allowed many times over under a unique index, which is what lets a
-- send that never retries skip the key entirely.
CREATE UNIQUE INDEX IF NOT EXISTS "communication_logs_attemptKey_key"
    ON "communication_logs"("attemptKey");
