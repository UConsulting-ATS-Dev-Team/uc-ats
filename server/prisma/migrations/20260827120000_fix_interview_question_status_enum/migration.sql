-- The original interview_questions migration declared "status" as TEXT, but the Prisma
-- model declares it as the InterviewQuestionStatus enum. Prisma casts every status
-- parameter to public."InterviewQuestionStatus", so with no such type in the database
-- the entire question bank failed at query time with 42704 (type does not exist).
-- Create the type and convert the column to match the model.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type t
    JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE t.typname = 'InterviewQuestionStatus' AND n.nspname = 'public'
  ) THEN
    CREATE TYPE "InterviewQuestionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');
  END IF;
END
$$;

-- Guarded so the file stays safe to re-run: db execute has no transaction wrapper.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'interview_questions'
      AND column_name = 'status'
      AND data_type = 'text'
  ) THEN
    ALTER TABLE "interview_questions" ALTER COLUMN "status" DROP DEFAULT;
    ALTER TABLE "interview_questions"
      ALTER COLUMN "status" TYPE "InterviewQuestionStatus"
      USING "status"::"InterviewQuestionStatus";
    ALTER TABLE "interview_questions" ALTER COLUMN "status" SET DEFAULT 'DRAFT';
  END IF;
END
$$;
