-- Form responses an application absorbed or ignored because the same candidate
-- had already applied in that cycle. Sync treats them as filed.
ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "supersededResponseIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
