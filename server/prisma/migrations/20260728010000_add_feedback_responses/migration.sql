-- AlterTable
ALTER TABLE "application_feedback_jobs" ADD COLUMN "feedbackToken" TEXT;
ALTER TABLE "application_feedback_jobs" ADD COLUMN "respondedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "application_feedback_jobs_feedbackToken_key" ON "application_feedback_jobs"("feedbackToken");

-- CreateTable
CREATE TABLE "feedback_responses" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "feedbackJobId" TEXT,
    "content" TEXT NOT NULL,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "feedback_responses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "feedback_responses_feedbackJobId_key" ON "feedback_responses"("feedbackJobId");
CREATE INDEX "feedback_responses_cycleId_submittedAt_idx" ON "feedback_responses"("cycleId", "submittedAt");

-- AddForeignKey
ALTER TABLE "feedback_responses" ADD CONSTRAINT "feedback_responses_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "recruiting_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "feedback_responses" ADD CONSTRAINT "feedback_responses_feedbackJobId_fkey" FOREIGN KEY ("feedbackJobId") REFERENCES "application_feedback_jobs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
