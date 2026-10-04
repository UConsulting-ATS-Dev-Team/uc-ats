-- Emoji reactions on chat messages. See MessageReaction. Re-runnable.
CREATE TABLE IF NOT EXISTS "message_reactions" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "emoji" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "message_reactions_messageId_userId_emoji_key"
    ON "message_reactions"("messageId", "userId", "emoji");
CREATE INDEX IF NOT EXISTS "message_reactions_messageId_idx" ON "message_reactions"("messageId");

DO $$ BEGIN
    ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_messageId_fkey"
        FOREIGN KEY ("messageId") REFERENCES "messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_userId_fkey"
        FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
