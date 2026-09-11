-- Decision emails held for human review. Processing decisions on Staging writes
-- one batch and one message per affected applicant; nothing is sent until an
-- admin approves it in Master Communications. Re-runnable: applied with
-- `prisma db execute`, which has no transaction of its own (see CLAUDE.md).

DO $$
BEGIN
  CREATE TYPE "DecisionOutcome" AS ENUM ('ADVANCED', 'REJECTED', 'ACCEPTED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "DecisionMessageStatus" AS ENUM ('PENDING', 'EXCLUDED', 'SENDING', 'SENT', 'FAILED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "decision_batches" (
  "id"            TEXT NOT NULL,
  "cycleId"       TEXT NOT NULL,
  "round"         TEXT NOT NULL,
  "templates"     JSONB NOT NULL,
  "processedById" TEXT NOT NULL,
  "processedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "decision_batches_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "decision_batches_cycleId_processedAt_idx" ON "decision_batches"("cycleId", "processedAt");

CREATE TABLE IF NOT EXISTS "decision_messages" (
  "id"                TEXT NOT NULL,
  "batchId"           TEXT NOT NULL,
  "applicationId"     TEXT NOT NULL,
  "candidateId"       TEXT,
  "userId"            TEXT,
  "email"             TEXT NOT NULL,
  "firstName"         TEXT NOT NULL,
  "lastName"          TEXT NOT NULL,
  "outcome"           "DecisionOutcome" NOT NULL,
  "fromRound"         TEXT NOT NULL,
  "toRound"           TEXT,
  "needsInvite"       BOOLEAN NOT NULL DEFAULT false,
  "status"            "DecisionMessageStatus" NOT NULL DEFAULT 'PENDING',
  "attempts"          INTEGER NOT NULL DEFAULT 0,
  "sentAt"            TIMESTAMP(3),
  "sentById"          TEXT,
  "error"             TEXT,
  "providerMessageId" TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "decision_messages_pkey" PRIMARY KEY ("id")
);

-- One email per decision, ever: reprocessing a round cannot queue a second copy.
CREATE UNIQUE INDEX IF NOT EXISTS "decision_messages_applicationId_fromRound_outcome_key"
  ON "decision_messages"("applicationId", "fromRound", "outcome");
CREATE INDEX IF NOT EXISTS "decision_messages_batchId_outcome_status_idx"
  ON "decision_messages"("batchId", "outcome", "status");

-- ADD CONSTRAINT has no IF NOT EXISTS form, hence the guard.
DO $$
BEGIN
  ALTER TABLE "decision_messages" ADD CONSTRAINT "decision_messages_batchId_fkey"
    FOREIGN KEY ("batchId") REFERENCES "decision_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
