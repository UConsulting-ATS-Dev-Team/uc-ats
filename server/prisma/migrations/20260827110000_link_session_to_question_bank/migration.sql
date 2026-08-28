-- Link interview session questions to the question bank with snapshot fields (ATS-23)

ALTER TABLE "interview_session_questions" ADD COLUMN IF NOT EXISTS "guidance" TEXT;
ALTER TABLE "interview_session_questions" ADD COLUMN IF NOT EXISTS "questionBankId" TEXT;

CREATE INDEX IF NOT EXISTS "interview_session_questions_questionBankId_idx" ON "interview_session_questions"("questionBankId");
