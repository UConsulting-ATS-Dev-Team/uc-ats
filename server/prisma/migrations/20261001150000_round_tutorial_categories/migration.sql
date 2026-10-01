-- One tutorial category per interview round, so each round's tutorials can gate it.
-- Re-runnable: applied by hand with `prisma db execute` while DIRECT_URL is broken.

ALTER TYPE "TutorialCategory" ADD VALUE IF NOT EXISTS 'COFFEE_CHATS';
ALTER TYPE "TutorialCategory" ADD VALUE IF NOT EXISTS 'FIRST_ROUND';
ALTER TYPE "TutorialCategory" ADD VALUE IF NOT EXISTS 'FINAL_ROUND';
