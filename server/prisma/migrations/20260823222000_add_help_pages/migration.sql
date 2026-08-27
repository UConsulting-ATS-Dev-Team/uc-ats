-- Help center tables: announcements, tutorials, and per-member read tracking.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'TutorialCategory') THEN
        CREATE TYPE "TutorialCategory" AS ENUM (
            'DOCUMENT_GRADING',
            'INTERVIEW_CONDUCT',
            'GTKUC',
            'ATS_NAVIGATION',
            'NEW_FEATURES'
        );
    END IF;
END $$;

CREATE TABLE IF NOT EXISTS "help_announcements" (
    "id"          TEXT NOT NULL,
    "title"       TEXT NOT NULL,
    "body"        TEXT NOT NULL DEFAULT '',
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cycleId"     TEXT,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "help_announcements_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "tutorials" (
    "id"          TEXT NOT NULL,
    "title"       TEXT NOT NULL,
    "description" TEXT,
    "category"    "TutorialCategory" NOT NULL,
    "videoUrl"    TEXT,
    "body"        TEXT,
    "order"       INTEGER NOT NULL DEFAULT 0,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tutorials_pkey" PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "member_announcement_reads" (
    "id"             TEXT NOT NULL,
    "memberId"       TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "readAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_announcement_reads_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'help_announcements_cycleId_fkey') THEN
        ALTER TABLE "help_announcements"
            ADD CONSTRAINT "help_announcements_cycleId_fkey"
            FOREIGN KEY ("cycleId") REFERENCES "recruiting_cycles"("id") ON DELETE SET NULL ON UPDATE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'member_announcement_reads_memberId_fkey') THEN
        ALTER TABLE "member_announcement_reads"
            ADD CONSTRAINT "member_announcement_reads_memberId_fkey"
            FOREIGN KEY ("memberId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'member_announcement_reads_announcementId_fkey') THEN
        ALTER TABLE "member_announcement_reads"
            ADD CONSTRAINT "member_announcement_reads_announcementId_fkey"
            FOREIGN KEY ("announcementId") REFERENCES "help_announcements"("id") ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "member_announcement_reads_memberId_announcementId_key"
    ON "member_announcement_reads"("memberId", "announcementId");

CREATE INDEX IF NOT EXISTS "help_announcements_cycleId_idx" ON "help_announcements"("cycleId");
CREATE INDEX IF NOT EXISTS "tutorials_category_idx" ON "tutorials"("category");
CREATE INDEX IF NOT EXISTS "member_announcement_reads_memberId_idx" ON "member_announcement_reads"("memberId");
CREATE INDEX IF NOT EXISTS "member_announcement_reads_announcementId_idx" ON "member_announcement_reads"("announcementId");
