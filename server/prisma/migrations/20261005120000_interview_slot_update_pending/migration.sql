-- A session whose time or place changed and whose people have not been told.
ALTER TABLE "interview_slots" ADD COLUMN IF NOT EXISTS "updatePendingSince" TIMESTAMP(3);
