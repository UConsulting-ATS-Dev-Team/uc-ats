-- Interview question bank (ATS-23 / ATS-68)

CREATE TABLE IF NOT EXISTS "interview_questions" (
    "id" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "guidance" TEXT,
    "round" TEXT NOT NULL,
    "category" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "interview_questions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "interview_questions_cycleId_idx" ON "interview_questions"("cycleId");
CREATE INDEX IF NOT EXISTS "interview_questions_round_idx" ON "interview_questions"("round");
CREATE INDEX IF NOT EXISTS "interview_questions_category_idx" ON "interview_questions"("category");
CREATE INDEX IF NOT EXISTS "interview_questions_status_idx" ON "interview_questions"("status");
