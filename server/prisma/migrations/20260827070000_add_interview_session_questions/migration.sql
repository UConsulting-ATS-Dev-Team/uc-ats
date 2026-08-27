-- Live interview session questions (ATS-13 / ATS-69)

CREATE TABLE IF NOT EXISTS "interview_session_questions" (
    "id" TEXT NOT NULL,
    "interviewId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "addedBy" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "interview_session_questions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "interview_session_questions_interviewId_position_idx" ON "interview_session_questions"("interviewId", "position");

ALTER TABLE "interview_session_questions" DROP CONSTRAINT IF EXISTS "interview_session_questions_interviewId_fkey";
ALTER TABLE "interview_session_questions" ADD CONSTRAINT "interview_session_questions_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
