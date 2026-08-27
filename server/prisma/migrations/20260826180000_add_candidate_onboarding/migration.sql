-- Self-reported applicant information collected at signup, for a candidate with
-- no application on file. Re-runnable: this file is applied with
-- `prisma db execute`, which has no transaction of its own (see CLAUDE.md).

CREATE TABLE IF NOT EXISTS "candidate_onboarding" (
  "id"                   TEXT NOT NULL,
  "candidateId"          TEXT NOT NULL,
  "phoneNumber"          TEXT NOT NULL,
  "graduationYear"       TEXT NOT NULL,
  "cumulativeGpa"        DECIMAL(3,2) NOT NULL,
  "major1"               TEXT NOT NULL,
  "major2"               TEXT,
  "gender"               TEXT,
  "isTransferStudent"    BOOLEAN NOT NULL,
  "isFirstGeneration"    BOOLEAN NOT NULL,
  "resumeStoragePath"    TEXT NOT NULL,
  "resumeOriginalName"   TEXT NOT NULL,
  "resumeFileSize"       INTEGER NOT NULL,
  "headshotStoragePath"  TEXT,
  "headshotOriginalName" TEXT,
  "headshotFileSize"     INTEGER,
  "completedAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "candidate_onboarding_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "candidate_onboarding_candidateId_key"
  ON "candidate_onboarding"("candidateId");

DO $$
BEGIN
  ALTER TABLE "candidate_onboarding"
    ADD CONSTRAINT "candidate_onboarding_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "candidates"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
