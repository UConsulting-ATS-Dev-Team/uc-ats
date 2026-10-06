-- A Send update in progress on a session, so two at once send once.
ALTER TABLE "interview_slots" ADD COLUMN IF NOT EXISTS "updateSendingSince" TIMESTAMP(3);
