-- Notifications that are about an interview rather than one of its sessions.
--
-- Asking interviewers when they are free is sent before any session exists -
-- that is the entire point of it - so slotId cannot be required. An interview
-- reference takes its place for those, and slot-scoped messages are unchanged.
--
-- Hand-written and re-runnable: prisma migrate dev cannot run here (stale
-- DIRECT_URL, see CLAUDE.md), and db execute has no transaction wrapper.

ALTER TABLE "interview_slot_notifications" ALTER COLUMN "slotId" DROP NOT NULL;
ALTER TABLE "interview_slot_notifications" ADD COLUMN IF NOT EXISTS "interviewId" TEXT;

CREATE INDEX IF NOT EXISTS "interview_slot_notifications_interviewId_idx"
  ON "interview_slot_notifications"("interviewId");

DO $$ BEGIN
  ALTER TABLE "interview_slot_notifications" ADD CONSTRAINT "interview_slot_notifications_interviewId_fkey"
    FOREIGN KEY ("interviewId") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- New reasons a scheduling email gets sent.
DO $$ BEGIN
  ALTER TYPE "InterviewSlotNotificationType" ADD VALUE IF NOT EXISTS 'AVAILABILITY_REQUEST';
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  ALTER TYPE "InterviewSlotNotificationType" ADD VALUE IF NOT EXISTS 'INTERVIEWER_ASSIGNED';
EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN
  ALTER TYPE "InterviewSlotNotificationType" ADD VALUE IF NOT EXISTS 'INTERVIEWER_REMOVED';
EXCEPTION WHEN others THEN NULL; END $$;
