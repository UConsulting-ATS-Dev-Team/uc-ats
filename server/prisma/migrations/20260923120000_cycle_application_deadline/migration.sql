-- Adds one nullable column. Existing rows stay null and code that predates it ignores it.
ALTER TABLE "recruiting_cycles" ADD COLUMN IF NOT EXISTS "applicationDeadline" TIMESTAMP(3);
