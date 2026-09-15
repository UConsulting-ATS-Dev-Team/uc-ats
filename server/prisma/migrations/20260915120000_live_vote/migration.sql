-- Live vote deliberations.
--
-- An admin opens a session on one Staging round; admins and members join and
-- vote yes/no on one candidate at a time. Votes are anonymous: a vote row holds
-- an HMAC of (ballot, user) under a server secret, never a user id or a time.
--
-- Two invariants Prisma cannot express are partial unique indexes below:
--   * at most one LOBBY/ACTIVE session in the whole app, and
--   * at most one OPEN ballot per session.
-- Closing a ballot also bumps the Staging change token, so the vote chip on
-- Staging rows refreshes on the console's normal poll.
--
-- Additive only. Hand-written and re-runnable: prisma migrate dev cannot run
-- here (stale DIRECT_URL, see CLAUDE.md), and db execute has no transaction
-- wrapper.

DO $$ BEGIN
  CREATE TYPE "LiveVoteSessionStatus" AS ENUM ('LOBBY', 'ACTIVE', 'ENDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "LiveVoteBallotStatus" AS ENUM ('OPEN', 'CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE "LiveVoteValue" AS ENUM ('YES', 'NO');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "deliberation_rubrics" (
  "id"          TEXT         NOT NULL,
  "phase"       TEXT         NOT NULL,
  "criteria"    JSONB        NOT NULL DEFAULT '[]',
  "updatedById" TEXT,
  "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"   TIMESTAMP(3) NOT NULL,
  CONSTRAINT "deliberation_rubrics_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "live_vote_sessions" (
  "id"           TEXT                    NOT NULL,
  "cycleId"      TEXT                    NOT NULL,
  "phase"        TEXT                    NOT NULL,
  "status"       "LiveVoteSessionStatus" NOT NULL DEFAULT 'LOBBY',
  "currentIndex" INTEGER,
  "version"      INTEGER                 NOT NULL DEFAULT 0,
  "rubric"       JSONB                   NOT NULL DEFAULT '[]',
  "createdById"  TEXT                    NOT NULL,
  "endedById"    TEXT,
  "startedAt"    TIMESTAMP(3),
  "endedAt"      TIMESTAMP(3),
  "createdAt"    TIMESTAMP(3)            NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"    TIMESTAMP(3)            NOT NULL,
  CONSTRAINT "live_vote_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "live_vote_session_candidates" (
  "id"            TEXT    NOT NULL,
  "sessionId"     TEXT    NOT NULL,
  "applicationId" TEXT    NOT NULL,
  "position"      INTEGER NOT NULL,
  CONSTRAINT "live_vote_session_candidates_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "live_vote_ballots" (
  "id"                 TEXT                   NOT NULL,
  "sessionId"          TEXT                   NOT NULL,
  "sessionCandidateId" TEXT                   NOT NULL,
  "roundNumber"        INTEGER                NOT NULL,
  "status"             "LiveVoteBallotStatus" NOT NULL DEFAULT 'OPEN',
  "openedAt"           TIMESTAMP(3)           NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "openedById"         TEXT                   NOT NULL,
  "closedAt"           TIMESTAMP(3),
  "closedById"         TEXT,
  "yesCount"           INTEGER,
  "noCount"            INTEGER,
  "eligibleCount"      INTEGER,
  "decisionApplied"    TEXT,
  "decidedById"        TEXT,
  "decidedAt"          TIMESTAMP(3),
  CONSTRAINT "live_vote_ballots_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "live_vote_votes" (
  "id"       TEXT            NOT NULL,
  "ballotId" TEXT            NOT NULL,
  "voterKey" TEXT            NOT NULL,
  "value"    "LiveVoteValue" NOT NULL,
  CONSTRAINT "live_vote_votes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "live_vote_participants" (
  "id"         TEXT         NOT NULL,
  "sessionId"  TEXT         NOT NULL,
  "userId"     TEXT         NOT NULL,
  "joinedAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leftAt"     TIMESTAMP(3),
  CONSTRAINT "live_vote_participants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "deliberation_rubrics_phase_key" ON "deliberation_rubrics"("phase");
CREATE INDEX IF NOT EXISTS "live_vote_sessions_cycleId_phase_idx" ON "live_vote_sessions"("cycleId", "phase");
CREATE INDEX IF NOT EXISTS "live_vote_sessions_status_idx" ON "live_vote_sessions"("status");
CREATE INDEX IF NOT EXISTS "live_vote_session_candidates_applicationId_idx" ON "live_vote_session_candidates"("applicationId");
CREATE UNIQUE INDEX IF NOT EXISTS "live_vote_session_candidates_sessionId_applicationId_key" ON "live_vote_session_candidates"("sessionId", "applicationId");
CREATE UNIQUE INDEX IF NOT EXISTS "live_vote_session_candidates_sessionId_position_key" ON "live_vote_session_candidates"("sessionId", "position");
CREATE INDEX IF NOT EXISTS "live_vote_ballots_sessionId_status_idx" ON "live_vote_ballots"("sessionId", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "live_vote_ballots_sessionCandidateId_roundNumber_key" ON "live_vote_ballots"("sessionCandidateId", "roundNumber");
CREATE UNIQUE INDEX IF NOT EXISTS "live_vote_votes_ballotId_voterKey_key" ON "live_vote_votes"("ballotId", "voterKey");
CREATE INDEX IF NOT EXISTS "live_vote_participants_userId_idx" ON "live_vote_participants"("userId");
CREATE UNIQUE INDEX IF NOT EXISTS "live_vote_participants_sessionId_userId_key" ON "live_vote_participants"("sessionId", "userId");

-- The invariants. Every row that is not ENDED indexes the same constant, so a
-- second open session is a unique violation (P2002) rather than a race.
CREATE UNIQUE INDEX IF NOT EXISTS "live_vote_sessions_single_open"
  ON "live_vote_sessions" ((true)) WHERE "status" IN ('LOBBY', 'ACTIVE');
CREATE UNIQUE INDEX IF NOT EXISTS "live_vote_ballots_single_open"
  ON "live_vote_ballots" ("sessionId") WHERE "status" = 'OPEN';

DO $$ BEGIN
  ALTER TABLE "live_vote_sessions" ADD CONSTRAINT "live_vote_sessions_cycleId_fkey"
    FOREIGN KEY ("cycleId") REFERENCES "recruiting_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "live_vote_sessions" ADD CONSTRAINT "live_vote_sessions_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "live_vote_session_candidates" ADD CONSTRAINT "live_vote_session_candidates_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "live_vote_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "live_vote_session_candidates" ADD CONSTRAINT "live_vote_session_candidates_applicationId_fkey"
    FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "live_vote_ballots" ADD CONSTRAINT "live_vote_ballots_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "live_vote_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "live_vote_ballots" ADD CONSTRAINT "live_vote_ballots_sessionCandidateId_fkey"
    FOREIGN KEY ("sessionCandidateId") REFERENCES "live_vote_session_candidates"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "live_vote_votes" ADD CONSTRAINT "live_vote_votes_ballotId_fkey"
    FOREIGN KEY ("ballotId") REFERENCES "live_vote_ballots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "live_vote_participants" ADD CONSTRAINT "live_vote_participants_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "live_vote_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "live_vote_participants" ADD CONSTRAINT "live_vote_participants_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Closing a ballot freezes its counts, which the Staging snapshot shows as a
-- chip. Votes themselves do not touch the snapshot, so only ballots bump.
DROP TRIGGER IF EXISTS "staging_change_token_bump" ON "live_vote_ballots";
CREATE TRIGGER "staging_change_token_bump"
  AFTER INSERT OR UPDATE OR DELETE ON "live_vote_ballots"
  FOR EACH STATEMENT EXECUTE FUNCTION "bump_staging_change_token"();
