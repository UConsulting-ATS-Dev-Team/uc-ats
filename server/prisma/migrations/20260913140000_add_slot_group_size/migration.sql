-- How many candidates share a rotation group in a session.
--
-- Coffee chats run in small groups that rotate between interviewer tables
-- together. Usually pairs, but a session that does not divide evenly needs a
-- three, and some run fours - so it is a number per session rather than a
-- constant.
--
-- Setting it turns on labelling at booking time: an arriving candidate joins
-- the last group with room. That is what keeps a label stable, which matters
-- because the label is what a candidate is told and what they say out loud at
-- a table.
--
-- Hand-written and re-runnable: prisma migrate dev cannot run here.

ALTER TABLE "interview_slots" ADD COLUMN IF NOT EXISTS "groupSize" INTEGER;
