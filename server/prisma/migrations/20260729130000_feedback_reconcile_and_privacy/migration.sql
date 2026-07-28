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
ALTER TABLE "recruiting_cycles" ADD COLUMN "feedbackAccessModel" TEXT DEFAULT 'CONFIDENTIAL';
ALTER TABLE "recruiting_cycles" ADD COLUMN "feedbackApproved" BOOLEAN DEFAULT false;
ALTER TABLE "recruiting_cycles" ADD COLUMN "feedbackApprovedBy" TEXT;
ALTER TABLE "recruiting_cycles" ADD COLUMN "feedbackApprovedAt" TIMESTAMP(3);
ALTER TABLE "recruiting_cycles" ALTER COLUMN "feedbackEnabled" SET DEFAULT false;

-- AlterTable
ALTER TABLE "applications" ADD COLUMN "decisionSendReconciledBy" TEXT;
ALTER TABLE "applications" ADD COLUMN "decisionSendReconciledAt" TIMESTAMP(3);
ALTER TABLE "applications" ADD COLUMN "decisionSendReconciledReason" TEXT;
ALTER TABLE "applications" ADD COLUMN "decisionSendReconciledFromStatus" TEXT;

-- AlterTable
ALTER TABLE "feedback_responses" ADD COLUMN "createdAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP;
