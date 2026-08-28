-- Add polling sync fields to live interview session questions (ATS-13)

ALTER TABLE "interview_session_questions" ADD COLUMN IF NOT EXISTS "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "interview_session_questions" ADD COLUMN IF NOT EXISTS "deletedAt" TIMESTAMP(3);

CREATE INDEX IF NOT EXISTS "interview_session_questions_interviewId_updatedAt_idx" ON "interview_session_questions"("interviewId", "updatedAt");
