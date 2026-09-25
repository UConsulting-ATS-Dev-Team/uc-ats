-- Log type for the email asking a GTKUC host to mark attendance after a slot.
ALTER TYPE "MeetingCommunicationType" ADD VALUE IF NOT EXISTS 'ATTENDANCE_REMINDER';
