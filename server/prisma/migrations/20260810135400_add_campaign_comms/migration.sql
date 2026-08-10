-- CreateEnum
CREATE TYPE "CampaignSendStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'SENDING', 'SENT', 'FAILED');

-- CreateTable
CREATE TABLE "campaign_templates" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "mergeFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "firstOfCycleGate" BOOLEAN NOT NULL DEFAULT false,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_templates_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_audiences" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_audiences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_sends" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT,
    "templateId" TEXT NOT NULL,
    "audienceId" TEXT,
    "name" TEXT NOT NULL,
    "status" "CampaignSendStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "sentBy" TEXT NOT NULL,
    "recipientCount" INTEGER,
    "previewCount" INTEGER,
    "errorLog" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "campaign_sends_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "campaign_send_logs" (
    "id" TEXT NOT NULL,
    "sendId" TEXT NOT NULL,
    "campaignSendId" TEXT,
    "candidateId" TEXT,
    "email" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "actorId" TEXT NOT NULL,
    "templateName" TEXT NOT NULL,
    "subject" TEXT NOT NULL,

    CONSTRAINT "campaign_send_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "suppressed_emails" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "reason" TEXT,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "suppressed_emails_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaign_templates_cycleId_idx" ON "campaign_templates"("cycleId");

-- CreateIndex
CREATE INDEX "campaign_audiences_cycleId_idx" ON "campaign_audiences"("cycleId");

-- CreateIndex
CREATE INDEX "campaign_sends_templateId_idx" ON "campaign_sends"("templateId");

-- CreateIndex
CREATE INDEX "campaign_sends_audienceId_idx" ON "campaign_sends"("audienceId");

-- CreateIndex
CREATE INDEX "campaign_sends_cycleId_idx" ON "campaign_sends"("cycleId");

-- CreateIndex
CREATE INDEX "campaign_sends_status_idx" ON "campaign_sends"("status");

-- CreateIndex
CREATE INDEX "campaign_send_logs_sendId_idx" ON "campaign_send_logs"("sendId");

-- CreateIndex
CREATE INDEX "campaign_send_logs_candidateId_idx" ON "campaign_send_logs"("candidateId");

-- CreateIndex
CREATE INDEX "campaign_send_logs_email_idx" ON "campaign_send_logs"("email");

-- CreateIndex
CREATE INDEX "campaign_send_logs_campaignSendId_idx" ON "campaign_send_logs"("campaignSendId");

-- CreateIndex
CREATE UNIQUE INDEX "suppressed_emails_email_key" ON "suppressed_emails"("email");

-- AddForeignKey
ALTER TABLE "campaign_templates" ADD CONSTRAINT "campaign_templates_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "recruiting_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_templates" ADD CONSTRAINT "campaign_templates_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_audiences" ADD CONSTRAINT "campaign_audiences_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "recruiting_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_audiences" ADD CONSTRAINT "campaign_audiences_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "campaign_templates"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_audienceId_fkey" FOREIGN KEY ("audienceId") REFERENCES "campaign_audiences"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_cycleId_fkey" FOREIGN KEY ("cycleId") REFERENCES "recruiting_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_sends" ADD CONSTRAINT "campaign_sends_sentBy_fkey" FOREIGN KEY ("sentBy") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_send_logs" ADD CONSTRAINT "campaign_send_logs_campaignSendId_fkey" FOREIGN KEY ("campaignSendId") REFERENCES "campaign_sends"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_send_logs" ADD CONSTRAINT "campaign_send_logs_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_send_logs" ADD CONSTRAINT "campaign_send_logs_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
