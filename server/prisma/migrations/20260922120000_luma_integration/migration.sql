-- Luma replaces the per-event Google Forms (docs/luma-integration-plan.md).
--
-- A Luma guest lands in luma_guests as the sync routine saw it, and
-- services/luma/ingestGuests.js turns it into the same event_rsvp /
-- event_attendance / member_event_rsvp rows a Google Form response produces, so
-- nothing that reads those tables changes. Luma rows have no form responseId,
-- which is why responseId becomes optional and lumaGuestId takes its place.
--
-- Re-runnable, like every migration applied by hand here.

DO $$ BEGIN
    CREATE TYPE "EventResponseSource" AS ENUM ('GOOGLE_FORM', 'LUMA');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "LumaMatchStatus" AS ENUM ('MATCHED_CANDIDATE', 'CREATED_CANDIDATE', 'MATCHED_MEMBER', 'UNMATCHED');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Events: the pasted link, the evt-... id it resolves to, and when the routine
-- last delivered guests for it (the only signal that the routine has stopped).
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "lumaUrl" TEXT;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "lumaEventId" TEXT;
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "lumaLastSyncedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX IF NOT EXISTS "events_lumaEventId_key" ON "events"("lumaEventId");

ALTER TABLE "event_rsvp" ALTER COLUMN "responseId" DROP NOT NULL;
ALTER TABLE "event_rsvp" ADD COLUMN IF NOT EXISTS "source" "EventResponseSource" NOT NULL DEFAULT 'GOOGLE_FORM';
ALTER TABLE "event_rsvp" ADD COLUMN IF NOT EXISTS "lumaGuestId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "event_rsvp_lumaGuestId_key" ON "event_rsvp"("lumaGuestId");

ALTER TABLE "event_attendance" ALTER COLUMN "responseId" DROP NOT NULL;
ALTER TABLE "event_attendance" ADD COLUMN IF NOT EXISTS "source" "EventResponseSource" NOT NULL DEFAULT 'GOOGLE_FORM';
ALTER TABLE "event_attendance" ADD COLUMN IF NOT EXISTS "lumaGuestId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "event_attendance_lumaGuestId_key" ON "event_attendance"("lumaGuestId");

ALTER TABLE "member_event_rsvp" ALTER COLUMN "responseId" DROP NOT NULL;
ALTER TABLE "member_event_rsvp" ADD COLUMN IF NOT EXISTS "source" "EventResponseSource" NOT NULL DEFAULT 'GOOGLE_FORM';
ALTER TABLE "member_event_rsvp" ADD COLUMN IF NOT EXISTS "lumaGuestId" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "member_event_rsvp_lumaGuestId_key" ON "member_event_rsvp"("lumaGuestId");

-- One RSVP and one attendance row per person per event. Nothing enforced that
-- before, so someone who submitted a Google Form twice has two rows. Keep the
-- earliest (it is when they actually first responded) and drop the rest, then
-- add the constraint. To see what this removes before applying, run the same
-- self-join as a SELECT:
--
--   SELECT DISTINCT later.* FROM "event_rsvp" later JOIN "event_rsvp" earlier
--     ON later."eventId" = earlier."eventId" AND later."candidateId" = earlier."candidateId"
--    AND (later."createdAt", later."id") > (earlier."createdAt", earlier."id");
--
-- Dropping the duplicates cannot change the participation score, which already
-- counts distinct events per candidate (services/stagingSnapshot.js).
DELETE FROM "event_rsvp" later
 USING "event_rsvp" earlier
 WHERE later."eventId" = earlier."eventId"
   AND later."candidateId" = earlier."candidateId"
   AND (later."createdAt", later."id") > (earlier."createdAt", earlier."id");
CREATE UNIQUE INDEX IF NOT EXISTS "event_rsvp_eventId_candidateId_key"
    ON "event_rsvp"("eventId", "candidateId");

DELETE FROM "event_attendance" later
 USING "event_attendance" earlier
 WHERE later."eventId" = earlier."eventId"
   AND later."candidateId" = earlier."candidateId"
   AND (later."createdAt", later."id") > (earlier."createdAt", earlier."id");
CREATE UNIQUE INDEX IF NOT EXISTS "event_attendance_eventId_candidateId_key"
    ON "event_attendance"("eventId", "candidateId");

DELETE FROM "member_event_rsvp" later
 USING "member_event_rsvp" earlier
 WHERE later."eventId" = earlier."eventId"
   AND later."memberId" = earlier."memberId"
   AND (later."createdAt", later."id") > (earlier."createdAt", earlier."id");
CREATE UNIQUE INDEX IF NOT EXISTS "member_event_rsvp_eventId_memberId_key"
    ON "member_event_rsvp"("eventId", "memberId");

CREATE TABLE IF NOT EXISTS "luma_guests" (
    "id" TEXT NOT NULL,
    "lumaGuestId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "approvalStatus" TEXT NOT NULL,
    "registeredAt" TIMESTAMP(3),
    "checkedInAt" TIMESTAMP(3),
    "joinedAt" TIMESTAMP(3),
    "uid" TEXT,
    "rawAnswers" JSONB NOT NULL,
    "raw" JSONB NOT NULL,
    "candidateId" TEXT,
    "userId" TEXT,
    "matchStatus" "LumaMatchStatus" NOT NULL,
    "matchNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "luma_guests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "luma_guests_lumaGuestId_key" ON "luma_guests"("lumaGuestId");
CREATE INDEX IF NOT EXISTS "luma_guests_eventId_matchStatus_idx" ON "luma_guests"("eventId", "matchStatus");

ALTER TABLE "luma_guests" DROP CONSTRAINT IF EXISTS "luma_guests_eventId_fkey";
ALTER TABLE "luma_guests" ADD CONSTRAINT "luma_guests_eventId_fkey"
    FOREIGN KEY ("eventId") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "luma_guests" DROP CONSTRAINT IF EXISTS "luma_guests_candidateId_fkey";
ALTER TABLE "luma_guests" ADD CONSTRAINT "luma_guests_candidateId_fkey"
    FOREIGN KEY ("candidateId") REFERENCES "candidates"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "luma_guests" DROP CONSTRAINT IF EXISTS "luma_guests_userId_fkey";
ALTER TABLE "luma_guests" ADD CONSTRAINT "luma_guests_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
