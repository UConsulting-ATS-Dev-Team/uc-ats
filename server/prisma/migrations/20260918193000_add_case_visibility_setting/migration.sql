-- Case book time restriction: how many hours before an interview's startDate a
-- MEMBER may read that interview's assigned case content.
-- Written to be re-runnable (IF NOT EXISTS / ON CONFLICT) because this project
-- applies migrations with `prisma db execute`, which has no transaction wrapper
-- of its own -- see CLAUDE.md, "Applying a migration".
CREATE TABLE IF NOT EXISTS "case_visibility_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "leadTimeHours" INTEGER NOT NULL DEFAULT 2,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "case_visibility_settings_pkey" PRIMARY KEY ("id")
);

INSERT INTO "case_visibility_settings" ("id", "leadTimeHours", "updatedAt")
VALUES ('singleton', 2, now())
ON CONFLICT ("id") DO NOTHING;
