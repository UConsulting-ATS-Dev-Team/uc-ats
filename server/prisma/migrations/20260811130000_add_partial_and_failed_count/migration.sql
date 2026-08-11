-- AlterEnum
ALTER TYPE "CampaignSendStatus" ADD VALUE 'PARTIAL';

-- AlterTable
ALTER TABLE "campaign_sends" ADD COLUMN     "failedRecipientCount" INTEGER;