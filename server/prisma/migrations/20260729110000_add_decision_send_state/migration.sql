-- AlterTable
ALTER TABLE "applications" ADD COLUMN "decisionSendStatus" TEXT;
ALTER TABLE "applications" ADD COLUMN "decisionSendMessageId" TEXT;
ALTER TABLE "applications" ADD COLUMN "decisionSendAttemptedAt" TIMESTAMP(3);
