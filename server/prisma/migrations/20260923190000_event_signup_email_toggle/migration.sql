-- Whether the Google Form event sync sends RSVP and attendance confirmation
-- emails of its own. Defaults to FALSE: sign-ups run through Luma now, and Luma
-- sends its own confirmation and calendar invite the moment somebody registers,
-- so an ATS email on top of it is a second message about the same sign-up. The
-- switch exists so a move back to Google Forms is one toggle rather than a
-- code change.
--
-- Written to be re-runnable (IF NOT EXISTS / ON CONFLICT) because this project
-- applies migrations with `prisma db execute`, which has no transaction wrapper
-- of its own -- see CLAUDE.md, "Applying a migration".
CREATE TABLE IF NOT EXISTS "event_email_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "sendSignupConfirmations" BOOLEAN NOT NULL DEFAULT false,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "event_email_settings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "event_email_settings" ("id", "sendSignupConfirmations", "updatedAt")
VALUES ('singleton', false, now())
ON CONFLICT ("id") DO NOTHING;
