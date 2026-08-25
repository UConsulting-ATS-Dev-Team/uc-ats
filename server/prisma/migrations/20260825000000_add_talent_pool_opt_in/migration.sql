-- Talent Partner Network (TPN) opt-in.
--
-- The question ("Would you like to be considered for exclusive internship,
-- part-time, and early-career opportunities through our Talent Partner
-- Network?") was added to the application form for the Winter 2026 cycle but
-- never mapped in form-config.json, so the answer only ever landed in
-- applications.rawResponses under question id 6656e3a3.
--
-- Nullable on purpose: Fall 2025 applications predate the question entirely,
-- and some Winter 2026 applications left it blank. NULL means "never asked or
-- not answered", which is distinct from an explicit No.
--
-- Written to be safely re-runnable (see CLAUDE.md: migrations here are applied
-- with `prisma db execute`, which has no transaction wrapper of its own).

ALTER TABLE "applications" ADD COLUMN IF NOT EXISTS "talentPoolOptIn" BOOLEAN;

-- Backfill from the raw Google Forms payload already stored on every row.
UPDATE "applications"
SET "talentPoolOptIn" = CASE
      "rawResponses" -> '6656e3a3' -> 'textAnswers' -> 'answers' -> 0 ->> 'value'
      WHEN 'Yes' THEN TRUE
      WHEN 'No'  THEN FALSE
      ELSE NULL
    END
WHERE "talentPoolOptIn" IS NULL
  AND "rawResponses" -> '6656e3a3' IS NOT NULL;
