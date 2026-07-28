-- CreateTable
CREATE TABLE "candidate_group_copy_events" (
    "id" TEXT NOT NULL,
    "interviewId" TEXT NOT NULL,
    "sourceGroupId" TEXT NOT NULL,
    "destinationGroupId" TEXT,
    "actorId" TEXT,
    "operationKey" TEXT NOT NULL,
    "additions" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "skipped" JSONB NOT NULL DEFAULT '[]'::jsonb,
    "additionCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "copiedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "candidate_group_copy_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "candidate_group_copy_events_interviewId_operationKey_key" ON "candidate_group_copy_events"("interviewId", "operationKey");

-- CreateIndex
CREATE INDEX "candidate_group_copy_events_interviewId_copiedAt_idx" ON "candidate_group_copy_events"("interviewId", "copiedAt");

-- AddForeignKey
ALTER TABLE "candidate_group_copy_events" ADD CONSTRAINT "candidate_group_copy_events_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_group_copy_events" ADD CONSTRAINT "candidate_group_copy_events_sourceGroupId_fkey" FOREIGN KEY ("sourceGroupId") REFERENCES "groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "candidate_group_copy_events" ADD CONSTRAINT "candidate_group_copy_events_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
