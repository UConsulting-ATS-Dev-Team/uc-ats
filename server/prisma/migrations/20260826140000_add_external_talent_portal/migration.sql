-- External talent portal: self-registered UCLA students as a third resume source.
--
-- Until now every assignable resume came from someone UConsulting already knew:
-- an applicant (Application.talentPoolOptIn) or a member (member_resumes.
-- shareConsent). This adds a third source with no prior relationship at all, so
-- it also adds the only thing that stands in for one - a verified @ucla.edu
-- address, recorded as users.emailVerifiedAt.
--
-- Written to be safely re-runnable (see CLAUDE.md: migrations here are applied
-- with `prisma db execute`, which has no transaction wrapper of its own, so a
-- half-applied file has to survive a second run). ADD CONSTRAINT has no
-- IF NOT EXISTS form, hence the DO/EXCEPTION guards.

-- ---------------------------------------------------------------------------
-- Email verification, on users
-- ---------------------------------------------------------------------------
-- Mirrors the existing resetToken / resetTokenExpiry pair rather than inventing
-- a second convention. Nullable and defaulted so every existing row - all of
-- them staff or applicant accounts created before this existed - keeps working
-- untouched: nothing outside the talent portal reads emailVerifiedAt.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerifiedAt" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerificationToken" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "emailVerificationExpiry" TIMESTAMP(3);
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "isExternalTalent" BOOLEAN NOT NULL DEFAULT false;

-- Unique so a token lookup is an index hit and a collision is a database error
-- rather than a silent cross-account verification. Tokens are 32 random bytes,
-- so a collision is theoretical - this is about which layer catches it.
CREATE UNIQUE INDEX IF NOT EXISTS "users_emailVerificationToken_key"
  ON "users"("emailVerificationToken");

-- ---------------------------------------------------------------------------
-- external_resumes
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS "external_resumes" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
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
    CONSTRAINT "external_resumes_pkey" PRIMARY KEY ("id")
);

-- One live resume per user, same partial-unique trick member_resumes uses and
-- for the same reason: it is what lets a re-upload create a new row instead of
-- mutating the old one, which is in turn what makes an already-committed
-- assignment immutable. Prisma cannot express a filtered unique index, so this
-- is SQL-only and `prisma migrate dev` will want to drop it.
CREATE UNIQUE INDEX IF NOT EXISTS "external_resumes_userId_current_key"
  ON "external_resumes"("userId") WHERE "isCurrent";
CREATE INDEX IF NOT EXISTS "external_resumes_userId_isCurrent_idx"
  ON "external_resumes"("userId", "isCurrent");
CREATE INDEX IF NOT EXISTS "external_resumes_shareConsent_isCurrent_idx"
  ON "external_resumes"("shareConsent", "isCurrent");

DO $$ BEGIN
  ALTER TABLE "external_resumes" ADD CONSTRAINT "external_resumes_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ---------------------------------------------------------------------------
-- client_resume_assignments gains a third target
-- ---------------------------------------------------------------------------

ALTER TABLE "client_resume_assignments" ADD COLUMN IF NOT EXISTS "externalResumeId" TEXT;

DO $$ BEGIN
  ALTER TABLE "client_resume_assignments"
    ADD CONSTRAINT "client_resume_assignments_externalResumeId_fkey"
    FOREIGN KEY ("externalResumeId") REFERENCES "external_resumes"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "client_resume_assignments_externalResumeId_idx"
  ON "client_resume_assignments"("externalResumeId");

-- Same reasoning as the two existing partial uniques: a plain UNIQUE over
-- nullable target columns prevents nothing, because Postgres treats NULLs as
-- distinct. Scoped to live rows so revoke-then-reassign stays legal.
CREATE UNIQUE INDEX IF NOT EXISTS "client_resume_assignments_client_external_live_key"
  ON "client_resume_assignments"("clientId", "externalResumeId")
  WHERE "externalResumeId" IS NOT NULL AND "revokedAt" IS NULL;

-- The one-target CHECK has to be replaced rather than added to: the existing
-- constraint reads num_nonnulls(applicationId, memberResumeId) = 1, which every
-- external-targeted row would violate. Dropping and recreating is safe here
-- because the new predicate is strictly weaker on the two old columns - any row
-- that satisfied the old one still satisfies the new one.
ALTER TABLE "client_resume_assignments"
  DROP CONSTRAINT IF EXISTS "client_resume_assignments_one_target";

DO $$ BEGIN
  ALTER TABLE "client_resume_assignments"
    ADD CONSTRAINT "client_resume_assignments_one_target"
    CHECK (num_nonnulls("applicationId", "memberResumeId", "externalResumeId") = 1);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
