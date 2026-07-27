-- AlterTable
ALTER TABLE "recruiting_cycles" ADD COLUMN "feedbackFormUrl" TEXT;

-- AlterTable
ALTER TABLE "applications" ADD COLUMN "decisionSentAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "application_feedback_jobs" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "cycleId" TEXT,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "dueAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "decisionSentAt" TIMESTAMP(3) NOT NULL,
    "feedbackFormUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "application_feedback_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "application_feedback_jobs_applicationId_type_decisionSentAt_key" ON "application_feedback_jobs"("applicationId", "type", "decisionSentAt");

-- CreateIndex
CREATE INDEX "application_feedback_jobs_status_dueAt_idx" ON "application_feedback_jobs"("status", "dueAt");

-- AddForeignKey
ALTER TABLE "application_feedback_jobs" ADD CONSTRAINT "application_feedback_jobs_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_feedback_jobs" ADD CONSTRAINT "application_feedback_jobs_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "recruiting_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
