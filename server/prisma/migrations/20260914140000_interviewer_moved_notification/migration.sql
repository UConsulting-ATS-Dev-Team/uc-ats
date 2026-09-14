-- An interviewer whose session changes is not newly assigned and not removed.
-- Sending INTERVIEWER_ASSIGNED for a move tells somebody who already knew they
-- were interviewing that they have been placed, which reads as a duplicate and
-- buries the one fact that matters: the time is different now.
DO $$
BEGIN
  ALTER TYPE "InterviewSlotNotificationType" ADD VALUE IF NOT EXISTS 'INTERVIEWER_MOVED';
EXCEPTION
  WHEN duplicate_object THEN NULL;
END
$$;
