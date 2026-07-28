-- Add deactivation fields to users
ALTER TABLE "users" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "users" ADD COLUMN "deactivatedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN "deactivatedBy" TEXT;
