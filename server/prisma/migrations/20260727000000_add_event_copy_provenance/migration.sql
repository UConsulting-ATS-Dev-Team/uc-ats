-- AlterTable
ALTER TABLE "events" ADD COLUMN     "copiedAt" TIMESTAMP(3),
ADD COLUMN     "copiedByUserId" TEXT,
ADD COLUMN     "copiedFromCycleId" TEXT,
ADD COLUMN     "copiedFromEventId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "events_cycleId_copiedFromCycleId_copiedFromEventId_key" ON "events"("cycleId", "copiedFromCycleId", "copiedFromEventId");
