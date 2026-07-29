-- AlterTable
ALTER TABLE "recruiting_cycles" ADD COLUMN "feedbackEnabled" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "recruiting_cycles" ADD COLUMN "feedbackCadenceHours" INTEGER NOT NULL DEFAULT 48;
ALTER TABLE "recruiting_cycles" ADD COLUMN "feedbackPrompt" TEXT;
ALTER TABLE "recruiting_cycles" ADD COLUMN "feedbackQuestions" JSONB;

-- AlterTable
ALTER TABLE "feedback_responses" ADD COLUMN "answers" JSONB;
