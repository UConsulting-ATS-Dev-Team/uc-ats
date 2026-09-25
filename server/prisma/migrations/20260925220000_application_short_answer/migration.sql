-- The Fall 2026 application replaced the cover letter upload with a short written
-- answer. It is graded through the cover letter rubric (CoverLetterScore), so the
-- only new storage is the text itself. coverLetterUrl stays for earlier cycles.
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "shortAnswer" TEXT;
