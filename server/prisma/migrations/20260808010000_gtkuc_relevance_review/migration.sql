-- The GTKUC relevance blurb is member-authored free text, so it is gated on
-- explicit admin review: `relevance` stays the member's draft and only
-- `approvedRelevance` (the exact text an admin cleared) is candidate-visible.
--
-- Existing rows start unapproved with no approved snapshot, so any blurb written
-- before this gate stops being shown to candidates until an admin reviews it.
CREATE TYPE "GtkucRelevanceReviewStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED');

ALTER TABLE "member_gtkuc_profiles"
  ADD COLUMN "approvedRelevance" TEXT,
  ADD COLUMN "relevanceReviewStatus" "GtkucRelevanceReviewStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
  ADD COLUMN "relevanceReviewNote" TEXT,
  ADD COLUMN "relevanceReviewedAt" TIMESTAMP(3),
  ADD COLUMN "relevanceReviewedById" TEXT;

ALTER TABLE "member_gtkuc_profiles" ADD CONSTRAINT "member_gtkuc_profiles_relevanceReviewedById_fkey"
    FOREIGN KEY ("relevanceReviewedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
