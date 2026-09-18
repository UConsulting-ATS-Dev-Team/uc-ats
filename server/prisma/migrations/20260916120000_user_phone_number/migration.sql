-- Phone number on staff accounts, for iMessage from Master Communications.
-- Re-runnable: applied by hand through the session pooler (see CLAUDE.md).
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "phoneNumber" TEXT;
