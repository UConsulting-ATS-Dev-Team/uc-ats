-- Who recruitment asked for availability on an invite-only round (final round).
-- Re-runnable: migrations are applied by hand while DIRECT_URL is broken.

-- The table and its backfill are one statement, run only when the table does not
-- exist yet. Final rounds that already collected availability were open to
-- everyone, so whoever already answered is invited and keeps their form and their
-- answers. Running the backfill on a replay would re-invite anybody an admin has
-- since taken off (their answers are kept on purpose), so it happens exactly once.
DO $$ BEGIN
    IF to_regclass('public.availability_invites') IS NULL THEN
        CREATE TABLE "availability_invites" (
            "id" TEXT NOT NULL,
            "interviewId" TEXT NOT NULL,
            "userId" TEXT NOT NULL,
            "invitedById" TEXT,
            "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
            CONSTRAINT "availability_invites_pkey" PRIMARY KEY ("id")
        );

        INSERT INTO "availability_invites" ("id", "interviewId", "userId", "createdAt")
        SELECT gen_random_uuid()::text, a."interviewId", a."userId", MIN(a."createdAt")
        FROM "interviewer_availability" a
        JOIN "interviews" i ON i."id" = a."interviewId"
        WHERE i."interviewType" IN ('FINAL_ROUND', 'ROUND_TWO')
        GROUP BY a."interviewId", a."userId";
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "availability_invites_interviewId_userId_key"
    ON "availability_invites"("interviewId", "userId");
CREATE INDEX IF NOT EXISTS "availability_invites_userId_idx" ON "availability_invites"("userId");

DO $$ BEGIN
    ALTER TABLE "availability_invites" ADD CONSTRAINT "availability_invites_interviewId_fkey"
        FOREIGN KEY ("interviewId") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "availability_invites" ADD CONSTRAINT "availability_invites_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "availability_invites" ADD CONSTRAINT "availability_invites_invitedById_fkey"
        FOREIGN KEY ("invitedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
