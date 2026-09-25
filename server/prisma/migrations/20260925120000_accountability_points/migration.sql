-- Member accountability points. Each type of activity is worth a number of
-- points and a member needs a target number of them per cycle. The defaults
-- live in code (services/accountabilityPoints.js), so both tables start empty:
-- a missing row means "the default", and a row exists only once an admin
-- changes something.
--
-- Written to be re-runnable (IF NOT EXISTS) because this project applies
-- migrations with `prisma db execute`, which has no transaction wrapper of its
-- own -- see CLAUDE.md, "Applying a migration".
CREATE TABLE IF NOT EXISTS "accountability_point_values" (
    "type" TEXT NOT NULL,
    "points" DECIMAL(4,2) NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "accountability_point_values_pkey" PRIMARY KEY ("type")
);

CREATE TABLE IF NOT EXISTS "accountability_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "targetPoints" DECIMAL(4,2) NOT NULL DEFAULT 3,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "accountability_settings_pkey" PRIMARY KEY ("id")
);

-- Which event-credited type attending an event earns (Info Session, Women's
-- Night, Case Workshop, Case Buddies). Null means the event earns nothing.
ALTER TABLE "events" ADD COLUMN IF NOT EXISTS "pointType" TEXT;
