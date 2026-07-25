-- CreateEnum
CREATE TYPE "CalendarSyncStatus" AS ENUM ('NOT_SYNCED', 'SYNCED', 'FAILED', 'CANCELLED');

-- AlterTable
ALTER TABLE "interviews" ADD COLUMN     "calendarAttendees" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "calendarEventId" TEXT,
ADD COLUMN     "calendarSyncError" TEXT,
ADD COLUMN     "calendarSyncStatus" "CalendarSyncStatus" NOT NULL DEFAULT 'NOT_SYNCED',
ADD COLUMN     "calendarSyncedAt" TIMESTAMP(3);
