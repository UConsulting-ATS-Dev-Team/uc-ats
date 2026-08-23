-- The free-text relevance blurb is gone: everything candidate-visible on a GTKUC
-- profile is now either a fixed-taxonomy tag or the member's own LinkedIn URL,
-- so there is nothing left for an admin to review.
ALTER TABLE "member_gtkuc_profiles" DROP CONSTRAINT IF EXISTS "member_gtkuc_profiles_relevanceReviewedById_fkey";

ALTER TABLE "member_gtkuc_profiles"
  DROP COLUMN IF EXISTS "relevance",
  DROP COLUMN IF EXISTS "approvedRelevance",
  DROP COLUMN IF EXISTS "relevanceReviewStatus",
  DROP COLUMN IF EXISTS "relevanceReviewNote",
  DROP COLUMN IF EXISTS "relevanceReviewedAt",
  DROP COLUMN IF EXISTS "relevanceReviewedById";

DROP TYPE IF EXISTS "GtkucRelevanceReviewStatus";

-- Auto-filled from the UConsulting team page (scripts/syncMemberLinkedin.js) and
-- editable by the member in the confirm/update modal.
ALTER TABLE "member_gtkuc_profiles" ADD COLUMN IF NOT EXISTS "linkedinUrl" TEXT;
