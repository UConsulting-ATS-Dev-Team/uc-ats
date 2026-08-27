-- Referrals for candidates who may not have applied yet (ATS-56)

ALTER TABLE "referrals" ALTER COLUMN "candidateId" DROP NOT NULL;

ALTER TABLE "referrals" ADD COLUMN IF NOT EXISTS "referredFirstName" TEXT;
ALTER TABLE "referrals" ADD COLUMN IF NOT EXISTS "referredLastName" TEXT;
ALTER TABLE "referrals" ADD COLUMN IF NOT EXISTS "referredEmail" TEXT;
ALTER TABLE "referrals" ADD COLUMN IF NOT EXISTS "referredByUserId" TEXT NOT NULL DEFAULT 'system';

CREATE INDEX IF NOT EXISTS "referrals_referredByUserId_idx" ON "referrals"("referredByUserId");
