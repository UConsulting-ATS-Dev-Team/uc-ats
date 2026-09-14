-- When an interviewer says they are free, recorded before the day is designed.
--
-- Attached to the interview, not to a session, and that is the whole point:
-- recruitment cannot know whether first round needs two panels at 10:00 or four
-- until it knows how many people can be there at 10:00. Hanging this off
-- interview_slots would require the sessions to exist before the information
-- that decides how many there should be.
--
-- Windows rather than ticked boxes for the same reason. "I can do 9 to 12"
-- answers a question nobody has asked yet.
--
-- Hand-written and re-runnable: prisma migrate dev cannot run here (stale
-- DIRECT_URL, see CLAUDE.md), and db execute has no transaction wrapper.

CREATE TABLE IF NOT EXISTS "interviewer_availability" (
    "id" TEXT NOT NULL,
    "interviewId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interviewer_availability_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "interviewer_availability_interviewId_startTime_idx"
  ON "interviewer_availability"("interviewId", "startTime");
CREATE INDEX IF NOT EXISTS "interviewer_availability_userId_idx"
  ON "interviewer_availability"("userId");

DO $$ BEGIN
  ALTER TABLE "interviewer_availability" ADD CONSTRAINT "interviewer_availability_interviewId_fkey"
    FOREIGN KEY ("interviewId") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE "interviewer_availability" ADD CONSTRAINT "interviewer_availability_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
