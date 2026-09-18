-- A slot that moved was not cancelled and was not newly booked.
--
-- Logging a reschedule as CANCELLATION would tell the reader the meeting is off
-- when it is still on, and CONFIRMATION would bury the one fact that matters:
-- the time already in the candidate's calendar is now wrong. It gets its own
-- type so the communications log stays readable.
--
-- Re-runnable: ADD VALUE IF NOT EXISTS, plus the duplicate_object guard for the
-- race where two runs reach the ALTER at once.
DO $$
BEGIN
  ALTER TYPE "MeetingCommunicationType" ADD VALUE IF NOT EXISTS 'RESCHEDULED';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
