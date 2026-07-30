-- AlterTable
ALTER TABLE "events"
  ADD COLUMN "calendarSyncStatus" TEXT,
  ADD COLUMN "calendarSyncError" TEXT;
