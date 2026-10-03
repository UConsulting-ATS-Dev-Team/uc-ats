-- Review team deliberations.
--
-- An admin walks one review team through its grades - outliers first - on a
-- screen the team watches live, overriding scores and setting Resume Review
-- decisions as they talk. Each edit is logged for the session summary.
--
-- One invariant Prisma cannot express is the partial unique index below: at
-- most one ACTIVE session per review team. Different teams may run at once.
--
-- Additive only. Hand-written and re-runnable: prisma migrate dev cannot run
-- here (stale DIRECT_URL, see CLAUDE.md), and db execute has no transaction
-- wrapper.

DO $$ BEGIN
  CREATE TYPE "ReviewDelibStatus" AS ENUM ('ACTIVE', 'ENDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "review_delib_sessions" (
  "id"                    TEXT                NOT NULL,
  "groupId"               TEXT                NOT NULL,
  "cycleId"               TEXT                NOT NULL,
  "status"                "ReviewDelibStatus" NOT NULL DEFAULT 'ACTIVE',
  "step"                  TEXT                NOT NULL DEFAULT 'OVERVIEW',
  "currentApplicationId"  TEXT,
  "outlierApplicationIds" JSONB               NOT NULL DEFAULT '[]',
  "thresholdPct"          DOUBLE PRECISION    NOT NULL DEFAULT 0.3,
  "version"               INTEGER             NOT NULL DEFAULT 0,
  "createdById"           TEXT                NOT NULL,
  "endedById"             TEXT,
  "startedAt"             TIMESTAMP(3)        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "endedAt"               TIMESTAMP(3),
  "updatedAt"             TIMESTAMP(3)        NOT NULL,
  CONSTRAINT "review_delib_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "review_delib_participants" (
  "id"         TEXT         NOT NULL,
  "sessionId"  TEXT         NOT NULL,
  "userId"     TEXT         NOT NULL,
  "joinedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leftAt"     TIMESTAMP(3),
  CONSTRAINT "review_delib_participants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "review_delib_changes" (
  "id"            TEXT         NOT NULL,
  "sessionId"     TEXT         NOT NULL,
  "userId"        TEXT         NOT NULL,
  "kind"          TEXT         NOT NULL,
  "applicationId" TEXT         NOT NULL,
  "candidateId"   TEXT         NOT NULL,
  "docType"       TEXT,
  "scoreId"       TEXT,
  "evaluatorId"   TEXT,
  "fromValue"     TEXT,
  "toValue"       TEXT,
  "originalScore" DECIMAL(5,2),
  "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "review_delib_changes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "review_delib_sessions_groupId_status_idx" ON "review_delib_sessions"("groupId", "status");
CREATE INDEX IF NOT EXISTS "review_delib_sessions_cycleId_status_idx" ON "review_delib_sessions"("cycleId", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "review_delib_participants_sessionId_userId_key" ON "review_delib_participants"("sessionId", "userId");
CREATE INDEX IF NOT EXISTS "review_delib_participants_userId_idx" ON "review_delib_participants"("userId");
CREATE INDEX IF NOT EXISTS "review_delib_changes_sessionId_createdAt_idx" ON "review_delib_changes"("sessionId", "createdAt");

-- The invariant: a second ACTIVE session for the same team is a unique
-- violation (P2002) rather than a race between two admins pressing Start.
CREATE UNIQUE INDEX IF NOT EXISTS "review_delib_sessions_one_open_per_group"
  ON "review_delib_sessions" ("groupId") WHERE "status" = 'ACTIVE';

DO $$ BEGIN
  ALTER TABLE "review_delib_sessions" ADD CONSTRAINT "review_delib_sessions_groupId_fkey"
    FOREIGN KEY ("groupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "review_delib_sessions" ADD CONSTRAINT "review_delib_sessions_cycleId_fkey"
    FOREIGN KEY ("cycleId") REFERENCES "recruiting_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "review_delib_sessions" ADD CONSTRAINT "review_delib_sessions_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "review_delib_participants" ADD CONSTRAINT "review_delib_participants_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "review_delib_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "review_delib_participants" ADD CONSTRAINT "review_delib_participants_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "review_delib_changes" ADD CONSTRAINT "review_delib_changes_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "review_delib_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
