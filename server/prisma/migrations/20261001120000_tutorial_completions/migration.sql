-- Who has sat through a tutorial category's required tutorials, per cycle.
-- Re-runnable: applied by hand with `prisma db execute` while DIRECT_URL is broken.

CREATE TABLE IF NOT EXISTS "tutorial_completions" (
    "id"          TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "cycleId"     TEXT NOT NULL,
    "category"    "TutorialCategory" NOT NULL,
    "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "tutorial_completions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "tutorial_completions_userId_cycleId_category_key"
    ON "tutorial_completions"("userId", "cycleId", "category");

CREATE INDEX IF NOT EXISTS "tutorial_completions_cycleId_idx"
    ON "tutorial_completions"("cycleId");

DO $$
BEGIN
    ALTER TABLE "tutorial_completions"
        ADD CONSTRAINT "tutorial_completions_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
    ALTER TABLE "tutorial_completions"
        ADD CONSTRAINT "tutorial_completions_cycleId_fkey"
        FOREIGN KEY ("cycleId") REFERENCES "recruiting_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
