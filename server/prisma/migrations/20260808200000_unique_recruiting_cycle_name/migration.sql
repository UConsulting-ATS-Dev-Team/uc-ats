-- Cycle names become unique so an exact retry of a bootstrap commit recovers the
-- cycle it already created rather than creating a duplicate.
--
-- Fail loudly with the offending names if the database already has duplicates,
-- instead of the opaque "could not create unique index" from Postgres.
DO $$
DECLARE
  duplicates TEXT;
BEGIN
  SELECT string_agg(name || ' (' || count || ')', ', ')
    INTO duplicates
    FROM (
      SELECT "name", COUNT(*) AS count
        FROM "recruiting_cycles"
       GROUP BY "name"
      HAVING COUNT(*) > 1
    ) dupes;

  IF duplicates IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot add unique index on recruiting_cycles.name: rename these duplicates first: %', duplicates;
  END IF;
END $$;

CREATE UNIQUE INDEX "recruiting_cycles_name_key" ON "recruiting_cycles"("name");
