-- Sign in with Google. Adds the Google identity columns, lets an account exist
-- without a password, and repairs the email casing that linking depends on.
-- Re-runnable: applied with `prisma db execute`, which has no transaction of its
-- own (see CLAUDE.md).

-- A Google-only account has no password. Null rather than an unusable hash, so
-- /login can tell "signs in with Google" apart from "wrong password".
ALTER TABLE "users" ALTER COLUMN "password" DROP NOT NULL;

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "googleId" TEXT;
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "googleLinkedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX IF NOT EXISTS "users_googleId_key" ON "users"("googleId");

-- Email casing. /register and /register-member stored the address exactly as it
-- was typed, while /register-external lowercased it, and the unique index is
-- case-sensitive - so `Joe@ucla.edu` and `joe@ucla.edu` are two rows to Postgres
-- and one mailbox to everyone else. Google always reports a lowercased address,
-- so without this a mixed-case account would not be found and a *second*
-- account would be created for somebody who already has one.
--
-- At the time of writing: 637 users, 10 mixed-case, 0 collisions. The guard is
-- here in case that changed between writing and applying - a collision needs a
-- human to decide which row survives, and must not be silently merged.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "users" GROUP BY lower("email") HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Case-insensitive duplicate emails exist; resolve them before backfilling';
  END IF;
END $$;

UPDATE "users" SET "email" = lower("email") WHERE "email" <> lower("email");

-- Stops the drift coming back, whatever a future caller forgets to normalize.
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_lower_key" ON "users"(lower("email"));
