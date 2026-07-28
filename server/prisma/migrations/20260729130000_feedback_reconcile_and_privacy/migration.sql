-- AlterTable
ALTER TABLE "application_feedback_jobs" ADD COLUMN "reconciledBy" TEXT;
ALTER TABLE "application_feedback_jobs" ADD COLUMN "reconciledAt" TIMESTAMP(3);
ALTER TABLE "application_feedback_jobs" ADD COLUMN "reconciledReason" TEXT;
ALTER TABLE "application_feedback_jobs" ADD COLUMN "reconciledFromStatus" TEXT;

-- AlterTable
ALTER TABLE "application_feedback_delivery_attempts" ADD COLUMN "reconciledBy" TEXT;
ALTER TABLE "application_feedback_delivery_attempts" ADD COLUMN "reconciledAt" TIMESTAMP(3);
ALTER TABLE "application_feedback_delivery_attempts" ADD COLUMN "reconciledReason" TEXT;
ALTER TABLE "application_feedback_delivery_attempts" ADD COLUMN "priorStatus" TEXT;

-- AlterTable
ALTER TABLE "recruiting_cycles" ADD COLUMN "feedbackPrivacyPolicy" TEXT;
ALTER TABLE "recruiting_cycles" ADD COLUMN "feedbackRetentionDays" INTEGER;
ALTER TABLE "recruiting_cycles" ALTER COLUMN "feedbackEnabled" SET DEFAULT false;
