-- Interview slots, candidate signups, interviewer assignments, and the delivery
-- log for scheduling email.
--
-- Written by hand rather than generated, for two reasons:
--
--   1. `prisma migrate dev` cannot run in this repo - DIRECT_URL carries a stale
--      password (see CLAUDE.md). This file is applied with
--      `prisma db execute --url "$SESSION_URL"` on the session pooler, port 5432,
--      then recorded with `prisma migrate resolve --applied`. db execute wraps
--      nothing in a transaction, so a half-applied file has to be safe to re-run:
--      hence IF NOT EXISTS everywhere and the duplicate_object guards.
--
--   2. The two partial unique indexes at the bottom cannot be expressed in
--      schema.prisma at all - Prisma has no syntax for an index WHERE clause.
--      They are the actual enforcement of "one seat per candidate per interview",
--      so losing them would lose the invariant while everything still validated.
--
-- If you regenerate this with `prisma migrate diff`, you will drop those two
-- indexes and the guards. Don't.
--
-- Order is load-bearing: the composite unique index on interview_slots must
-- exist before the composite foreign keys that reference it.

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "InterviewSlotSignupStatus" AS ENUM ('CONFIRMED', 'WAITLISTED', 'NEEDS_PLACEMENT', 'CANCELLED', 'RELEASED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateEnum
DO $$ BEGIN
  CREATE TYPE "InterviewSlotNotificationType" AS ENUM ('CONFIRMATION', 'WAITLIST_ADDED', 'PROMOTED', 'FALLBACK_RELEASED', 'CANCELLATION', 'MOVED_BY_ADMIN', 'ADMIN_OVERFLOW_ALERT', 'REMINDER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateTable
CREATE TABLE IF NOT EXISTS "interview_slots" (
    "id" TEXT NOT NULL,
    "interviewId" TEXT NOT NULL,
    "label" TEXT,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "location" TEXT,
    "candidateCapacity" INTEGER,
    "interviewerCapacity" INTEGER,
    "signupOpensAt" TIMESTAMP(3),
    "signupClosesAt" TIMESTAMP(3),
    "legacyGroupId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interview_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "interview_slot_signups" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "interviewId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "status" "InterviewSlotSignupStatus" NOT NULL DEFAULT 'CONFIRMED',
    "signedUpAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "waitlistedAt" TIMESTAMP(3),
    "heldSeatId" TEXT,
    "promotedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "placedById" TEXT,
    "movedById" TEXT,
    "movedAt" TIMESTAMP(3),
    "moveReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interview_slot_signups_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "interview_slot_assignments" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "interviewId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "InterviewerRole" NOT NULL DEFAULT 'INTERVIEWER',
    "signedUpAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedBy" TEXT,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "interview_slot_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE IF NOT EXISTS "interview_slot_notifications" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "signupId" TEXT,
    "type" "InterviewSlotNotificationType" NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "queuedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "interview_slot_notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
-- Must precede the composite foreign keys below, which reference this pair.
CREATE UNIQUE INDEX IF NOT EXISTS "interview_slots_id_interviewId_key" ON "interview_slots"("id", "interviewId");
CREATE UNIQUE INDEX IF NOT EXISTS "interview_slots_interviewId_legacyGroupId_key" ON "interview_slots"("interviewId", "legacyGroupId");
CREATE INDEX IF NOT EXISTS "interview_slots_interviewId_startTime_idx" ON "interview_slots"("interviewId", "startTime");

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "interview_slot_signups_heldSeatId_key" ON "interview_slot_signups"("heldSeatId");
CREATE INDEX IF NOT EXISTS "interview_slot_signups_slotId_status_idx" ON "interview_slot_signups"("slotId", "status");
CREATE INDEX IF NOT EXISTS "interview_slot_signups_slotId_status_waitlistedAt_idx" ON "interview_slot_signups"("slotId", "status", "waitlistedAt");
CREATE INDEX IF NOT EXISTS "interview_slot_signups_interviewId_status_idx" ON "interview_slot_signups"("interviewId", "status");
CREATE INDEX IF NOT EXISTS "interview_slot_signups_applicationId_status_idx" ON "interview_slot_signups"("applicationId", "status");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "interview_slot_assignments_slotId_removedAt_idx" ON "interview_slot_assignments"("slotId", "removedAt");
CREATE INDEX IF NOT EXISTS "interview_slot_assignments_userId_idx" ON "interview_slot_assignments"("userId");

-- CreateIndex
CREATE INDEX IF NOT EXISTS "interview_slot_notifications_slotId_idx" ON "interview_slot_notifications"("slotId");
CREATE INDEX IF NOT EXISTS "interview_slot_notifications_signupId_idx" ON "interview_slot_notifications"("signupId");
CREATE INDEX IF NOT EXISTS "interview_slot_notifications_status_idx" ON "interview_slot_notifications"("status");

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "interview_slots" ADD CONSTRAINT "interview_slots_interviewId_fkey"
    FOREIGN KEY ("interviewId") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
-- Composite: carrying interviewId down onto the child row is what makes the
-- partial unique indexes at the bottom expressible, and this constraint is what
-- stops that copy from drifting away from the slot's own interviewId.
DO $$ BEGIN
  ALTER TABLE "interview_slot_signups" ADD CONSTRAINT "interview_slot_signups_slotId_interviewId_fkey"
    FOREIGN KEY ("slotId", "interviewId") REFERENCES "interview_slots"("id", "interviewId") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "interview_slot_signups" ADD CONSTRAINT "interview_slot_signups_applicationId_fkey"
    FOREIGN KEY ("applicationId") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
-- Self-referential: a waitlist row points at the confirmed seat it is holding
-- meanwhile. SET NULL rather than CASCADE, because losing the fallback seat must
-- not silently delete the waitlist entry that was waiting on it.
DO $$ BEGIN
  ALTER TABLE "interview_slot_signups" ADD CONSTRAINT "interview_slot_signups_heldSeatId_fkey"
    FOREIGN KEY ("heldSeatId") REFERENCES "interview_slot_signups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "interview_slot_assignments" ADD CONSTRAINT "interview_slot_assignments_slotId_interviewId_fkey"
    FOREIGN KEY ("slotId", "interviewId") REFERENCES "interview_slots"("id", "interviewId") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "interview_slot_assignments" ADD CONSTRAINT "interview_slot_assignments_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "interview_slot_notifications" ADD CONSTRAINT "interview_slot_notifications_slotId_fkey"
    FOREIGN KEY ("slotId") REFERENCES "interview_slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- AddForeignKey
DO $$ BEGIN
  ALTER TABLE "interview_slot_notifications" ADD CONSTRAINT "interview_slot_notifications_signupId_fkey"
    FOREIGN KEY ("signupId") REFERENCES "interview_slot_signups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- CreateIndex (partial - not expressible in schema.prisma)
--
-- The real enforcement of the two invariants the booking logic depends on. A
-- candidate holds at most one confirmed seat and at most one waitlist entry per
-- interview, and the serialisable transaction that books them is relying on the
-- database to make that true rather than on having checked first.
--
-- Partial on purpose. A plain UNIQUE (interviewId, applicationId) would count
-- cancelled rows and lock a candidate out of an interview forever the first time
-- they cancelled or an admin removed them - the bug the abandoned issue-63 branch
-- shipped as @@unique([slotId, userId]). NEEDS_PLACEMENT is deliberately absent
-- from both: someone awaiting a hand-placed seat still holds neither.
CREATE UNIQUE INDEX IF NOT EXISTS "interview_slot_signups_one_confirmed_per_interview"
  ON "interview_slot_signups" ("interviewId", "applicationId")
  WHERE "status" = 'CONFIRMED';

CREATE UNIQUE INDEX IF NOT EXISTS "interview_slot_signups_one_waitlist_per_interview"
  ON "interview_slot_signups" ("interviewId", "applicationId")
  WHERE "status" = 'WAITLISTED';
