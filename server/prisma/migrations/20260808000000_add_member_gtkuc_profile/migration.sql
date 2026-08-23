-- Candidate-facing GTKUC member profile + per-cycle confirmation
CREATE TABLE "member_gtkuc_profiles" (
    "id" TEXT NOT NULL,
    "memberId" TEXT NOT NULL,
    "industries" TEXT[],
    "interests" TEXT[],
    "relevance" TEXT,
    "candidateVisible" BOOLEAN NOT NULL DEFAULT true,
    "hiddenFromGtkuc" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "member_gtkuc_profiles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "member_gtkuc_profiles_memberId_key" ON "member_gtkuc_profiles"("memberId");

ALTER TABLE "member_gtkuc_profiles" ADD CONSTRAINT "member_gtkuc_profiles_memberId_fkey"
    FOREIGN KEY ("memberId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "member_gtkuc_profile_confirmations" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "cycleId" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_gtkuc_profile_confirmations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "member_gtkuc_profile_confirmations_profileId_cycleId_key"
    ON "member_gtkuc_profile_confirmations"("profileId", "cycleId");

ALTER TABLE "member_gtkuc_profile_confirmations" ADD CONSTRAINT "member_gtkuc_profile_confirmations_profileId_fkey"
    FOREIGN KEY ("profileId") REFERENCES "member_gtkuc_profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "member_gtkuc_profile_confirmations" ADD CONSTRAINT "member_gtkuc_profile_confirmations_cycleId_fkey"
    FOREIGN KEY ("cycleId") REFERENCES "recruiting_cycles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
