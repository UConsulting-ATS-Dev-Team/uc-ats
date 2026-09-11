-- Round-one questions asked of one candidate instead of the whole group.
-- behavioral_questions.applicationId NULL keeps a row group-wide, which is every
-- row that existed before this. Re-runnable: applied with `prisma db execute`,
-- which has no transaction of its own (see CLAUDE.md).

ALTER TABLE "behavioral_questions" ADD COLUMN IF NOT EXISTS "applicationId" TEXT;

DO $$ BEGIN
  ALTER TABLE "behavioral_questions"
    ADD CONSTRAINT "behavioral_questions_applicationId_fkey"
    FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS "behavioral_questions_interviewId_applicationId_idx"
  ON "behavioral_questions"("interviewId", "applicationId");
