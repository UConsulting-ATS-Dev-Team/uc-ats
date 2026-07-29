-- Add Google Calendar sync tracking to meeting slots for GTKUC invites.
ALTER TABLE "meeting_slots" ADD COLUMN "calendarEventId" TEXT;
ALTER TABLE "meeting_slots" ADD COLUMN "calendarSyncStatus" TEXT DEFAULT 'PENDING';
ALTER TABLE "meeting_slots" ADD COLUMN "calendarSyncError" TEXT;
ALTER TABLE "meeting_slots" ADD COLUMN "calendarSyncAt" TIMESTAMP(3);
ALTER TABLE "meeting_slots" ADD COLUMN "calendarRetryCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "meeting_slots" ADD COLUMN "calendarRetryAt" TIMESTAMP(3);
