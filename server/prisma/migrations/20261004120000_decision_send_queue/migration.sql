-- Decision emails are sent by a worker instead of inside the approving request.
-- Re-runnable: every statement checks before it changes anything.
ALTER TYPE "DecisionMessageStatus" ADD VALUE IF NOT EXISTS 'QUEUED';
ALTER TYPE "DecisionMessageStatus" ADD VALUE IF NOT EXISTS 'UNCONFIRMED';

ALTER TABLE "decision_messages" ADD COLUMN IF NOT EXISTS "nextAttemptAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "decision_messages_status_nextAttemptAt_idx"
  ON "decision_messages"("status", "nextAttemptAt");
