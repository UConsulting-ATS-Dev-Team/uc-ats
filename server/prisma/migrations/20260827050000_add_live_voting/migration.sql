-- Live deliberation voting tables (ATS-54 / ATS-67)

CREATE TABLE IF NOT EXISTS "vote_sessions" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "deliberationId" TEXT,
    "candidateId" TEXT,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "requiredVotes" INTEGER,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),
    CONSTRAINT "vote_sessions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "vote_options" (
    "id" TEXT NOT NULL,
    "voteSessionId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "vote_options_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "votes" (
    "id" TEXT NOT NULL,
    "voteSessionId" TEXT NOT NULL,
    "optionId" TEXT NOT NULL,
    "voterId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "votes_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "vote_sessions_cycleId_idx" ON "vote_sessions"("cycleId");
CREATE INDEX IF NOT EXISTS "vote_sessions_deliberationId_idx" ON "vote_sessions"("deliberationId");
CREATE INDEX IF NOT EXISTS "vote_sessions_candidateId_idx" ON "vote_sessions"("candidateId");
CREATE INDEX IF NOT EXISTS "vote_options_voteSessionId_idx" ON "vote_options"("voteSessionId");
CREATE INDEX IF NOT EXISTS "votes_voteSessionId_idx" ON "votes"("voteSessionId");
CREATE INDEX IF NOT EXISTS "votes_optionId_idx" ON "votes"("optionId");
CREATE UNIQUE INDEX IF NOT EXISTS "votes_voteSessionId_voterId_key" ON "votes"("voteSessionId", "voterId");

ALTER TABLE "vote_options" DROP CONSTRAINT IF EXISTS "vote_options_voteSessionId_fkey";
ALTER TABLE "vote_options" ADD CONSTRAINT "vote_options_voteSessionId_fkey" FOREIGN KEY ("voteSessionId") REFERENCES "vote_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "votes" DROP CONSTRAINT IF EXISTS "votes_voteSessionId_fkey";
ALTER TABLE "votes" ADD CONSTRAINT "votes_voteSessionId_fkey" FOREIGN KEY ("voteSessionId") REFERENCES "vote_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "votes" DROP CONSTRAINT IF EXISTS "votes_optionId_fkey";
ALTER TABLE "votes" ADD CONSTRAINT "votes_optionId_fkey" FOREIGN KEY ("optionId") REFERENCES "vote_options"("id") ON DELETE CASCADE ON UPDATE CASCADE;
