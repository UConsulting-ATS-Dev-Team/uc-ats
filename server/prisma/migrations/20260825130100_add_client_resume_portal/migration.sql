-- Talent Partner Network: client resume portal.
--
-- Applicant consent is Application.talentPoolOptIn (added by the TPN migration
-- 20260825000000_add_talent_pool_opt_in); member consent is
-- member_resumes.shareConsent. Nothing here is assignable without one of those
-- recording an explicit yes.
--
-- Written to be safely re-runnable (see CLAUDE.md: migrations here are applied
-- with `prisma db execute`, which has no transaction wrapper of its own, so a
-- half-applied file has to survive a second run). CREATE TYPE and
-- ADD CONSTRAINT have no IF NOT EXISTS form, hence the DO/EXCEPTION guards.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "ResumeVisibility" AS ENUM ('BLIND', 'BASIC', 'FULL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "talent_partner_clients" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organization" TEXT NOT NULL,
    "visibility" "ResumeVisibility" NOT NULL DEFAULT 'BLIND',
    "notes" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "talent_partner_clients_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "member_resumes" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "isCurrent" BOOLEAN NOT NULL DEFAULT true,
    "storagePath" TEXT NOT NULL,
    "originalName" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "major1" TEXT NOT NULL,
    "major2" TEXT,
    "graduationYear" TEXT NOT NULL,
    "gender" TEXT,
    "shareConsent" BOOLEAN NOT NULL DEFAULT false,
    "consentAt" TIMESTAMP(3),
    "consentRevokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "member_resumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "client_assignment_batches" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "filterJson" JSONB,
    "matchedCount" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "client_assignment_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "client_resume_assignments" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "applicationId" TEXT,
    "memberResumeId" TEXT,
    "assignedById" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    CONSTRAINT "client_resume_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "client_resume_access_logs" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "assignmentId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "client_resume_access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "talent_partner_clients_userId_key" ON "talent_partner_clients"("userId");
CREATE INDEX IF NOT EXISTS "talent_partner_clients_organization_idx" ON "talent_partner_clients"("organization");

-- One live resume per member. Partial unique index: Prisma cannot express a
-- filtered unique index, so this is SQL-only. It is what lets a re-upload create
-- a new row instead of mutating the old one, which is in turn what makes an
-- already-committed assignment immutable.
CREATE UNIQUE INDEX IF NOT EXISTS "member_resumes_memberId_current_key" ON "member_resumes"("memberId") WHERE "isCurrent";
CREATE INDEX IF NOT EXISTS "member_resumes_memberId_isCurrent_idx" ON "member_resumes"("memberId", "isCurrent");
CREATE INDEX IF NOT EXISTS "member_resumes_shareConsent_isCurrent_idx" ON "member_resumes"("shareConsent", "isCurrent");

CREATE INDEX IF NOT EXISTS "client_assignment_batches_clientId_createdAt_idx" ON "client_assignment_batches"("clientId", "createdAt");

-- Covers the portal's only list query - filter by client, drop revoked, sort by
-- assignedAt - in a single index.
CREATE INDEX IF NOT EXISTS "client_resume_assignments_clientId_revokedAt_assignedAt_idx" ON "client_resume_assignments"("clientId", "revokedAt", "assignedAt");
CREATE INDEX IF NOT EXISTS "client_resume_assignments_batchId_idx" ON "client_resume_assignments"("batchId");
-- PostgreSQL does not auto-index foreign key columns, and the assignment
-- preview filters on both of these to answer "already assigned to this client?".
CREATE INDEX IF NOT EXISTS "client_resume_assignments_applicationId_idx" ON "client_resume_assignments"("applicationId");
CREATE INDEX IF NOT EXISTS "client_resume_assignments_memberResumeId_idx" ON "client_resume_assignments"("memberResumeId");

-- A plain UNIQUE over the two nullable target columns would prevent nothing:
-- PostgreSQL treats NULLs as distinct, so every applicant row (memberResumeId
-- NULL) would count as unique regardless of applicationId. Two partial unique
-- indexes scoped to live rows do the job, and leave revoke-then-reassign legal.
CREATE UNIQUE INDEX IF NOT EXISTS "client_resume_assignments_client_app_live_key"
  ON "client_resume_assignments"("clientId", "applicationId")
  WHERE "applicationId" IS NOT NULL AND "revokedAt" IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "client_resume_assignments_client_member_live_key"
  ON "client_resume_assignments"("clientId", "memberResumeId")
  WHERE "memberResumeId" IS NOT NULL AND "revokedAt" IS NULL;

CREATE INDEX IF NOT EXISTS "client_resume_access_logs_clientId_createdAt_idx" ON "client_resume_access_logs"("clientId", "createdAt");
CREATE INDEX IF NOT EXISTS "client_resume_access_logs_assignmentId_idx" ON "client_resume_access_logs"("assignmentId");

-- An assignment targets an applicant or a member, never both and never neither.
-- Prisma cannot represent CHECK, so this is SQL-only.
DO $$ BEGIN
  ALTER TABLE "client_resume_assignments"
    ADD CONSTRAINT "client_resume_assignments_one_target"
    CHECK (num_nonnulls("applicationId", "memberResumeId") = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "talent_partner_clients" ADD CONSTRAINT "talent_partner_clients_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "talent_partner_clients" ADD CONSTRAINT "talent_partner_clients_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "member_resumes" ADD CONSTRAINT "member_resumes_memberId_fkey" FOREIGN KEY ("memberId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "client_assignment_batches" ADD CONSTRAINT "client_assignment_batches_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "talent_partner_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "client_assignment_batches" ADD CONSTRAINT "client_assignment_batches_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "client_resume_assignments" ADD CONSTRAINT "client_resume_assignments_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "talent_partner_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "client_resume_assignments" ADD CONSTRAINT "client_resume_assignments_batchId_fkey" FOREIGN KEY ("batchId") REFERENCES "client_assignment_batches"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "client_resume_assignments" ADD CONSTRAINT "client_resume_assignments_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "client_resume_assignments" ADD CONSTRAINT "client_resume_assignments_memberResumeId_fkey" FOREIGN KEY ("memberResumeId") REFERENCES "member_resumes"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "client_resume_assignments" ADD CONSTRAINT "client_resume_assignments_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "client_resume_assignments" ADD CONSTRAINT "client_resume_assignments_revokedById_fkey" FOREIGN KEY ("revokedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "client_resume_access_logs" ADD CONSTRAINT "client_resume_access_logs_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "talent_partner_clients"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "client_resume_access_logs" ADD CONSTRAINT "client_resume_access_logs_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "client_resume_access_logs" ADD CONSTRAINT "client_resume_access_logs_assignmentId_fkey" FOREIGN KEY ("assignmentId") REFERENCES "client_resume_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
