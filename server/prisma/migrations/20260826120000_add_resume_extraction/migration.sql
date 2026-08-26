-- Searchable text pulled out of resume PDFs. Derived data: safe to drop and
-- re-run scripts/extractResumeText.js.
CREATE TABLE IF NOT EXISTS "resume_extractions" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT,
    "memberResumeId" TEXT,
    "text" TEXT NOT NULL,
    "extractorVersion" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "charCount" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "resume_extractions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "resume_extractions_applicationId_key"
    ON "resume_extractions"("applicationId");

CREATE UNIQUE INDEX IF NOT EXISTS "resume_extractions_memberResumeId_key"
    ON "resume_extractions"("memberResumeId");

CREATE INDEX IF NOT EXISTS "resume_extractions_extractorVersion_idx"
    ON "resume_extractions"("extractorVersion");

DO $$
BEGIN
  ALTER TABLE "resume_extractions" ADD CONSTRAINT "resume_extractions_applicationId_fkey"
      FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  ALTER TABLE "resume_extractions" ADD CONSTRAINT "resume_extractions_memberResumeId_fkey"
      FOREIGN KEY ("memberResumeId") REFERENCES "member_resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Exactly one source per row, mirroring the CHECK on client_resume_assignments.
DO $$
BEGIN
  ALTER TABLE "resume_extractions" ADD CONSTRAINT "resume_extractions_one_source"
      CHECK (("applicationId" IS NOT NULL)::int + ("memberResumeId" IS NOT NULL)::int = 1);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
