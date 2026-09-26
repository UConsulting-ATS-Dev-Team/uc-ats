-- Lets an admin turn member RSVPs off for an event that does not need them.
-- Defaults to on, so every existing event keeps the RSVP it has today.
--
-- Re-runnable with IF NOT EXISTS, because this project applies migrations with
-- `prisma db execute`, which has no transaction wrapper. See CLAUDE.md,
-- "Applying a migration".
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "memberRsvpEnabled" BOOLEAN NOT NULL DEFAULT true;
