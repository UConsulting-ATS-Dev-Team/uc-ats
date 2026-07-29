-- AlterTable
ALTER TABLE "application_feedback_jobs" DROP COLUMN "respondedAt";
ALTER TABLE "application_feedback_jobs" ADD COLUMN "responded" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "feedback_responses" DROP COLUMN "submittedAt";
