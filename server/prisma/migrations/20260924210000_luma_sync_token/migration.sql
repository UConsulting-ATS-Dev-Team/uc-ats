-- The Luma sync token, generated from Event Management instead of being set by
-- hand on Render. It is stored in plain text on purpose: the whole point is
-- that an admin can read it back to paste into the routine's prompt, so there
-- is nothing to compare a hash against. LUMA_SYNC_TOKEN in the environment
-- still works and is checked alongside this one, so an existing deployment
-- keeps syncing across this migration.
--
-- No row is inserted. An absent row and a NULL token both mean "no token has
-- been generated", which the endpoints answer 503 to, exactly as an unset
-- environment variable does.
--
-- Written to be re-runnable (IF NOT EXISTS) because this project applies
-- migrations with `prisma db execute`, which has no transaction wrapper of its
-- own -- see CLAUDE.md, "Applying a migration".
CREATE TABLE IF NOT EXISTS "luma_sync_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "token" TEXT,
    "tokenSetAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "luma_sync_settings_pkey" PRIMARY KEY ("id")
);
