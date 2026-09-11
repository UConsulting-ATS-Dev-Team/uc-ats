-- Sealed recruiting records. A candidate's scores, evaluations, comments and
-- application become readable only after entering the executive-committee
-- password once recordsLockedAt is set (automatically when they become a
-- member, or by hand). Re-runnable: applied with `prisma db execute`, which has
-- no transaction of its own (see CLAUDE.md).

ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "recordsLockedAt" TIMESTAMP(3);
ALTER TABLE "candidates" ADD COLUMN IF NOT EXISTS "recordsLockedById" TEXT;

-- One row, id 'singleton'. Holds only a bcrypt hash of the executive password.
CREATE TABLE IF NOT EXISTS "exec_access_settings" (
  "id"           TEXT NOT NULL DEFAULT 'singleton',
  "passwordHash" TEXT NOT NULL,
  "updatedById"  TEXT,
  "updatedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "exec_access_settings_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "exec_access_logs" (
  "id"          TEXT NOT NULL,
  "userId"      TEXT,
  "action"      TEXT NOT NULL,
  "candidateId" TEXT,
  "ipAddress"   TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "exec_access_logs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "exec_access_logs_createdAt_idx" ON "exec_access_logs"("createdAt");
CREATE INDEX IF NOT EXISTS "exec_access_logs_candidateId_idx" ON "exec_access_logs"("candidateId");
