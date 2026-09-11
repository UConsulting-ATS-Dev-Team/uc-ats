-- Fall 2025 document scores were written before score rows carried a cycleId, so
-- they sit untagged and every cycle-scoped read (the application detail, the
-- past-cycle view) drops them. Tag them by the cycle the candidate actually
-- applied in.
--
-- Rule A: untagged rows from the Fall 2025 review window whose candidate applied
--   that cycle. Covers returning applicants, whose later scores are already tagged.
-- Rule B: whatever is left, when the candidate only ever applied in one cycle,
--   which is unambiguous by definition. Catches the lone Winter 2026 video score.
--
-- Re-runnable: every statement is scoped to "cycleId" IS NULL, so a second run
-- matches nothing. Applied with `prisma db execute`, which has no transaction of
-- its own (see CLAUDE.md).

-- Rule A ---------------------------------------------------------------------
UPDATE "resume_scores" s
SET "cycleId" = c.id
FROM "recruiting_cycles" c
WHERE s."cycleId" IS NULL
  AND c.name = 'Fall 2025'
  AND s."createdAt" < TIMESTAMP '2025-11-01'
  AND EXISTS (
    SELECT 1 FROM "applications" a
    WHERE a."candidateId" = s."candidateId" AND a."cycleId" = c.id
  );

UPDATE "cover_letter_scores" s
SET "cycleId" = c.id
FROM "recruiting_cycles" c
WHERE s."cycleId" IS NULL
  AND c.name = 'Fall 2025'
  AND s."createdAt" < TIMESTAMP '2025-11-01'
  AND EXISTS (
    SELECT 1 FROM "applications" a
    WHERE a."candidateId" = s."candidateId" AND a."cycleId" = c.id
  );

UPDATE "video_scores" s
SET "cycleId" = c.id
FROM "recruiting_cycles" c
WHERE s."cycleId" IS NULL
  AND c.name = 'Fall 2025'
  AND s."createdAt" < TIMESTAMP '2025-11-01'
  AND EXISTS (
    SELECT 1 FROM "applications" a
    WHERE a."candidateId" = s."candidateId" AND a."cycleId" = c.id
  );

-- Rule B ---------------------------------------------------------------------
UPDATE "resume_scores" s
SET "cycleId" = (
  SELECT MIN(a."cycleId") FROM "applications" a
  WHERE a."candidateId" = s."candidateId" AND a."cycleId" IS NOT NULL
)
WHERE s."cycleId" IS NULL
  AND (
    SELECT COUNT(DISTINCT a."cycleId") FROM "applications" a
    WHERE a."candidateId" = s."candidateId" AND a."cycleId" IS NOT NULL
  ) = 1;

UPDATE "cover_letter_scores" s
SET "cycleId" = (
  SELECT MIN(a."cycleId") FROM "applications" a
  WHERE a."candidateId" = s."candidateId" AND a."cycleId" IS NOT NULL
)
WHERE s."cycleId" IS NULL
  AND (
    SELECT COUNT(DISTINCT a."cycleId") FROM "applications" a
    WHERE a."candidateId" = s."candidateId" AND a."cycleId" IS NOT NULL
  ) = 1;

UPDATE "video_scores" s
SET "cycleId" = (
  SELECT MIN(a."cycleId") FROM "applications" a
  WHERE a."candidateId" = s."candidateId" AND a."cycleId" IS NOT NULL
)
WHERE s."cycleId" IS NULL
  AND (
    SELECT COUNT(DISTINCT a."cycleId") FROM "applications" a
    WHERE a."candidateId" = s."candidateId" AND a."cycleId" IS NOT NULL
  ) = 1;
