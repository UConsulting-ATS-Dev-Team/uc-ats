-- Vote session final confirmation fields (ATS-54)

ALTER TABLE "vote_sessions" ADD COLUMN IF NOT EXISTS "confirmedOptionId" TEXT;
ALTER TABLE "vote_sessions" ADD COLUMN IF NOT EXISTS "confirmedBy" TEXT;
ALTER TABLE "vote_sessions" ADD COLUMN IF NOT EXISTS "confirmedAt" TIMESTAMP(3);
