-- AlterTable
ALTER TABLE "application_feedback_jobs" ADD COLUMN "claimToken" TEXT;
ALTER TABLE "application_feedback_jobs" ADD COLUMN "claimedAt" TIMESTAMP(3);
ALTER TABLE "application_feedback_jobs" ADD COLUMN "messageId" TEXT;

-- CreateIndex
CREATE INDEX "application_feedback_jobs_status_claimedAt_idx" ON "application_feedback_jobs"("status", "claimedAt");

-- CreateTable
CREATE TABLE "application_feedback_delivery_attempts" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "claimToken" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "messageId" TEXT,
    "error" TEXT,
    "feedbackFormUrl" TEXT,
    "attemptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_feedback_delivery_attempts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "application_feedback_delivery_attempts_claimToken_key" ON "application_feedback_delivery_attempts"("claimToken");
CREATE INDEX "application_feedback_delivery_attempts_jobId_attemptedAt_idx" ON "application_feedback_delivery_attempts"("jobId", "attemptedAt");

-- AddForeignKey
ALTER TABLE "application_feedback_delivery_attempts" ADD CONSTRAINT "application_feedback_delivery_attempts_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "application_feedback_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;
