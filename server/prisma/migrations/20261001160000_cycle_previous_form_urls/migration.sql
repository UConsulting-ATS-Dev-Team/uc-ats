-- Earlier versions of a cycle's application form, still synced.
ALTER TABLE "recruiting_cycles" ADD COLUMN IF NOT EXISTS "previousFormUrls" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
