-- Virtual coffee chats: interviews recruitment schedules by hand, with no
-- candidate self-signup. See Interview.isVirtual.
ALTER TABLE "interviews" ADD COLUMN IF NOT EXISTS "isVirtual" BOOLEAN NOT NULL DEFAULT false;
