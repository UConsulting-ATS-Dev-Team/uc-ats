-- Add member accountability tracking for events, GTKUC, and interviews

-- Allow events to store a member attendance form URL separate from candidate attendance.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "memberAttendanceForm" TEXT;

-- Track whether each assigned interviewer actually attended.
ALTER TABLE "interview_assignments" ADD COLUMN IF NOT EXISTS "attended" BOOLEAN NOT NULL DEFAULT false;

-- New table: member attendance at events (manual or synced from a Google Form).
CREATE TABLE IF NOT EXISTS "member_event_attendance" (
  "id" TEXT NOT NULL,
  "responseId" TEXT,
  "eventId" TEXT NOT NULL,
  "memberId" TEXT NOT NULL,
  "source" TEXT DEFAULT 'MANUAL',
  "createdAt" TIMESTAMP(3) WITHOUT TIME ZONE NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "member_event_attendance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "member_event_attendance_responseId_key" UNIQUE ("responseId"),
  CONSTRAINT "member_event_attendance_eventId_memberId_key" UNIQUE ("eventId", "memberId")
);

CREATE INDEX IF NOT EXISTS "member_event_attendance_eventId_idx" ON "member_event_attendance"("eventId");
CREATE INDEX IF NOT EXISTS "member_event_attendance_memberId_idx" ON "member_event_attendance"("memberId");

-- Foreign keys to events and users.
ALTER TABLE "member_event_attendance"
  ADD CONSTRAINT "member_event_attendance_eventId_fkey"
  FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "member_event_attendance"
  ADD CONSTRAINT "member_event_attendance_memberId_fkey"
  FOREIGN KEY ("memberId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
