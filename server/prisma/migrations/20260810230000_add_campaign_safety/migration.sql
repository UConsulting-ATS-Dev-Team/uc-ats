-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "CampaignSendStatus" ADD VALUE 'PENDING_APPROVAL';
ALTER TYPE "CampaignSendStatus" ADD VALUE 'APPROVED';
ALTER TYPE "CampaignSendStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "campaign_sends" ADD COLUMN     "approvalFingerprint" TEXT,
ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedBy" TEXT,
ADD COLUMN     "audienceFilters" JSONB,
ADD COLUMN     "eligibilityBasis" TEXT,
ADD COLUMN     "recipientSnapshot" JSONB,
ADD COLUMN     "renderedPreview" TEXT,
ADD COLUMN     "templateBody" TEXT,
ADD COLUMN     "templateName" TEXT,
ADD COLUMN     "templateSubject" TEXT,
ADD COLUMN     "templateVersion" INTEGER;

-- AlterTable
ALTER TABLE "campaign_send_logs" ADD COLUMN     "attemptNumber" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "renderedBody" TEXT,
ADD COLUMN     "templateVersion" INTEGER;

-- CreateTable
CREATE TABLE "subscribers" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "candidateId" TEXT,
    "firstName" TEXT,
    "lastName" TEXT,
    "consented" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "noticeVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "subscribers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "consent_events" (
    "id" TEXT NOT NULL,
    "subscriberId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "consented" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "noticeVersion" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actorId" TEXT,

    CONSTRAINT "consent_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "subscribers_email_key" ON "subscribers"("email");

-- CreateIndex
CREATE INDEX "subscribers_candidateId_idx" ON "subscribers"("candidateId");

-- CreateIndex
CREATE INDEX "consent_events_subscriberId_idx" ON "consent_events"("subscriberId");

-- CreateIndex
CREATE INDEX "consent_events_email_idx" ON "consent_events"("email");

-- CreateIndex
CREATE INDEX "consent_events_actorId_idx" ON "consent_events"("actorId");

-- CreateIndex
CREATE INDEX "campaign_sends_approvedBy_idx" ON "campaign_sends"("approvedBy");

-- CreateIndex
CREATE INDEX "campaign_send_logs_status_idx" ON "campaign_send_logs"("status");

-- CreateIndex
CREATE UNIQUE INDEX "campaign_send_logs_campaignSendId_email_attemptNumber_key" ON "campaign_send_logs"("campaignSendId", "email", "attemptNumber");

-- AddForeignKey
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_approvedBy_fkey" FOREIGN KEY ("approvedBy") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscribers" ADD CONSTRAINT "subscribers_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_subscriberId_fkey" FOREIGN KEY ("subscriberId") REFERENCES "subscribers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "consent_events" ADD CONSTRAINT "consent_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

