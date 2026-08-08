-- CreateEnum
CREATE TYPE "EventFormStatus" AS ENUM ('PENDING_FORM', 'CONNECTED');

-- AlterTable: structured timeline + audit on the recruiting cycle
ALTER TABLE "recruiting_cycles"
  ADD COLUMN "createdById" TEXT,
  ADD COLUMN "timelineSnapshot" JSONB,
  ADD COLUMN "timelineCommittedAt" TIMESTAMP(3),
  ADD COLUMN "publishChangeSet" JSONB;

-- AlterTable: provenance for generated event shells
ALTER TABLE "events"
  ADD COLUMN "generatedFromStage" TEXT,
  ADD COLUMN "formStatus" "EventFormStatus";

-- CreateIndex
CREATE UNIQUE INDEX "events_cycleId_generatedFromStage_key" ON "events"("cycleId", "generatedFromStage");

-- AddForeignKey
ALTER TABLE "recruiting_cycles"
  ADD CONSTRAINT "recruiting_cycles_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
