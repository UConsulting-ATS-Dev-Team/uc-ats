-- Version history for application resumes. Candidates can replace their own
-- resume until the cycle's resume deadline; every version is kept so a score
-- recorded against an earlier resume can still be traced back to the file the
-- reviewer actually read.
--
-- Written to be re-runnable: `prisma db execute` has no transaction wrapper of
-- its own (see CLAUDE.md, "Applying a migration"), so a half-applied file has
-- to be safe to replay.

CREATE TABLE IF NOT EXISTS "resume_uploads" (
    "id" TEXT NOT NULL,
    -- NULL when the file is not ours: the resume an application arrived with
    -- lives in Google Drive, uploaded through the application form.
    "storagePath" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "originalName" TEXT,
    "sizeBytes" INTEGER,
    "applicationId" TEXT NOT NULL,
    "uploadedById" TEXT,
    "uploadedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    -- Set when a newer upload takes over. The row with NULL is the version
    -- applications."resumeUrl" currently points at.
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "resume_uploads_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "resume_uploads_applicationId_uploadedAt_idx"
    ON "resume_uploads"("applicationId", "uploadedAt");

DO $$
BEGIN
    ALTER TABLE "resume_uploads"
        ADD CONSTRAINT "resume_uploads_applicationId_fkey"
        FOREIGN KEY ("applicationId") REFERENCES "applications"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "resume_uploads"
        ADD CONSTRAINT "resume_uploads_uploadedById_fkey"
        FOREIGN KEY ("uploadedById") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;
