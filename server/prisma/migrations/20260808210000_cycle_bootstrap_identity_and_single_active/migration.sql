-- Bootstrap retries are identified by the whole request, not just the timeline:
-- a commit that flips `activate` or edits a generated event's name/location/
-- visibility is a different operation and must not be answered with the result of
-- an earlier commit that happened to reuse the name.
ALTER TABLE "recruiting_cycles"
  ADD COLUMN "bootstrapFingerprint" TEXT;

-- "At most one active recruiting cycle" becomes a database invariant. Doing it in
-- application code alone cannot hold: two concurrent activations each read a
-- snapshot without the other's row, deactivate nothing relevant, and both commit
-- active. A partial unique index makes the loser fail instead.
--
-- Fail loudly with the offending names if the database already has more than one
-- active cycle, rather than the opaque "could not create unique index".
DO $$
DECLARE
  actives TEXT;
BEGIN
  SELECT string_agg("name", ', ')
    INTO actives
    FROM "recruiting_cycles"
   WHERE "isActive";

  IF (SELECT COUNT(*) FROM "recruiting_cycles" WHERE "isActive") > 1 THEN
    RAISE EXCEPTION 'Cannot enforce a single active recruiting cycle: deactivate all but one of these first: %', actives;
  END IF;
END $$;

CREATE UNIQUE INDEX "recruiting_cycles_single_active" ON "recruiting_cycles" (("isActive")) WHERE "isActive";
