-- Conditional polling for the Staging console.
--
-- The console's snapshot read is expensive (~9s in-transaction, ~840KB), so clients
-- must not fetch it on a timer. They poll this token instead and fetch the snapshot
-- only when it moves.
--
-- The bump lives in database triggers rather than in route handlers on purpose: a
-- token that misses a write is worse than no token at all, because the console would
-- then sit silently stale instead of merely lagging. Triggers cover every writer --
-- API routes, the Google Forms sync, one-off scripts, and psql alike.
--
-- Additive only: creates one table, one function, and one trigger per watched table.
-- Nothing existing is dropped or altered.

CREATE TABLE IF NOT EXISTS "staging_change_tokens" (
  "id"        TEXT         NOT NULL,
  "version"   BIGINT       NOT NULL DEFAULT 0,
  "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "staging_change_tokens_pkey" PRIMARY KEY ("id")
);

INSERT INTO "staging_change_tokens" ("id", "version")
VALUES ('staging', 0)
ON CONFLICT ("id") DO NOTHING;

-- The UPDATE is wrapped so a failure here can never fail the write that triggered it.
-- Degrading to "the token stops moving" costs freshness; letting this raise would cost
-- the application every write to eleven tables.
CREATE OR REPLACE FUNCTION "bump_staging_change_token"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    UPDATE "staging_change_tokens"
       SET "version" = "version" + 1,
           "changedAt" = CURRENT_TIMESTAMP
     WHERE "id" = 'staging';
  EXCEPTION WHEN OTHERS THEN
    NULL;
  END;
  RETURN NULL;
END;
$$;

-- FOR EACH STATEMENT, not FOR EACH ROW: a 294-row form sync should cost one bump,
-- not 294. The token only has to change, not count.
DO $$
DECLARE
  t TEXT;
  watched TEXT[] := ARRAY[
    'recruiting_cycles', 'events', 'groups', 'applications', 'candidates',
    'resume_scores', 'cover_letter_scores', 'video_scores', 'event_attendance',
    'meeting_signups', 'flagged_documents'
  ];
BEGIN
  FOREACH t IN ARRAY watched LOOP
    IF to_regclass(format('%I', t)) IS NULL THEN
      RAISE EXCEPTION 'staging change token: expected table % does not exist', t;
    END IF;
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', 'staging_change_token_bump', t);
    EXECUTE format(
      'CREATE TRIGGER %I AFTER INSERT OR UPDATE OR DELETE ON %I '
      'FOR EACH STATEMENT EXECUTE FUNCTION "bump_staging_change_token"()',
      'staging_change_token_bump', t
    );
  END LOOP;
END
$$;
