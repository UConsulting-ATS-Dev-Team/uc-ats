-- Rotation groups inside a coffee chat session.
--
-- A session holds forty people who move between interviewer tables in pairs
-- labelled 1A, 1B, 2A. At a table the interviewer asks which group they are and
-- pulls up exactly those candidates, so the label is the identifier that
-- matters - it is what a candidate says out loud.
--
-- A column rather than a table: a group is a label shared by two rows in one
-- session, with no attributes of its own. The ?groupIds= contract addresses
-- them as "<slotId>:<label>", which it can do because that contract has always
-- been an opaque string.
--
-- Null for first round, where the session already is the group.
--
-- Hand-written and re-runnable: prisma migrate dev cannot run here (stale
-- DIRECT_URL, see CLAUDE.md), and db execute has no transaction wrapper.

ALTER TABLE "interview_slot_signups" ADD COLUMN IF NOT EXISTS "groupLabel" TEXT;

CREATE INDEX IF NOT EXISTS "interview_slot_signups_slotId_groupLabel_idx"
  ON "interview_slot_signups"("slotId", "groupLabel");
