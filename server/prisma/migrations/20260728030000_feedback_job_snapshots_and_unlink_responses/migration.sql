-- AlterTable
ALTER TABLE "application_feedback_jobs" ADD COLUMN "feedbackPrompt" TEXT;
ALTER TABLE "application_feedback_jobs" ADD COLUMN "feedbackQuestions" JSONB;

-- AlterTable
ALTER TABLE "feedback_responses" ADD COLUMN "promptSnapshot" TEXT;
ALTER TABLE "feedback_responses" ADD COLUMN "questionsSnapshot" JSONB;

-- DropForeignKey
ALTER TABLE "feedback_responses" DROP CONSTRAINT IF EXISTS "feedback_responses_feedbackJobId_fkey";

-- DropIndex
DROP INDEX IF EXISTS "feedback_responses_feedbackJobId_key";

-- AlterTable
ALTER TABLE "feedback_responses" DROP COLUMN IF EXISTS "feedbackJobId";
