-- When a GTKUC host (or an admin) said a slot's attendance is finished. Without
-- it an unmarked signup and a no-show both read attended = false. No backfill:
-- a past slot where everyone is checked already counts as done without it.
ALTER TABLE "meeting_slots" ADD COLUMN IF NOT EXISTS "attendanceMarkedAt" TIMESTAMP(3);
ALTER TABLE "meeting_slots" ADD COLUMN IF NOT EXISTS "attendanceMarkedById" TEXT;
