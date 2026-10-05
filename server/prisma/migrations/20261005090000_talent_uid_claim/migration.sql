-- A UID typed into the talent profile, and the code that proves it.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "claimedStudentId" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "uidCodeHash" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "uidCodeExpiresAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "uidCodeAttempts" INTEGER NOT NULL DEFAULT 0;
