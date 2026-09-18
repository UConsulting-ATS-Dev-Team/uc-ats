-- Referrals for people who have not applied yet.
--
-- A MANUAL referral is added on an application page and has a candidateId from
-- the start. A PRE_APPLICATION referral is submitted by name only, carries no
-- candidateId, and is claimed by form sync once a matching Candidate appears.
--
-- Written to be safely re-runnable: `prisma db execute` applies this file
-- without a transaction of its own (see CLAUDE.md), so a half-applied run has
-- to survive a second pass.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'ReferralSource') THEN
    CREATE TYPE "ReferralSource" AS ENUM ('MANUAL', 'PRE_APPLICATION');
  END IF;
END
$$;

-- A pre-application referral has nobody to point at yet.
ALTER TABLE "referrals" ALTER COLUMN "candidateId" DROP NOT NULL;

ALTER TABLE "referrals" ADD COLUMN IF NOT EXISTS "source" "ReferralSource" NOT NULL DEFAULT 'MANUAL';
ALTER TABLE "referrals" ADD COLUMN IF NOT EXISTS "referredFirstName" TEXT;
ALTER TABLE "referrals" ADD COLUMN IF NOT EXISTS "referredLastName" TEXT;
ALTER TABLE "referrals" ADD COLUMN IF NOT EXISTS "referredNameKey" TEXT;
ALTER TABLE "referrals" ADD COLUMN IF NOT EXISTS "referredByUserId" TEXT;
ALTER TABLE "referrals" ADD COLUMN IF NOT EXISTS "claimedAt" TIMESTAMP(3);

-- Nullable and ON DELETE SET NULL: removing a member must not take the
-- referrals they submitted with them.
ALTER TABLE "referrals" DROP CONSTRAINT IF EXISTS "referrals_referredByUserId_fkey";
ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referredByUserId_fkey"
  FOREIGN KEY ("referredByUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX IF NOT EXISTS "referrals_candidateId_idx" ON "referrals"("candidateId");
CREATE INDEX IF NOT EXISTS "referrals_cycleId_idx" ON "referrals"("cycleId");
CREATE INDEX IF NOT EXISTS "referrals_referredByUserId_idx" ON "referrals"("referredByUserId");
-- The lookup form sync runs on every new application: unclaimed referrals in
-- this cycle whose normalized name matches the candidate's.
CREATE INDEX IF NOT EXISTS "referrals_cycleId_referredNameKey_idx" ON "referrals"("cycleId", "referredNameKey");
