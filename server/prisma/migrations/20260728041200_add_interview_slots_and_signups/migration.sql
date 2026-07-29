-- CreateTable
CREATE TABLE "interview_slots" (
    "id" TEXT NOT NULL,
    "interviewId" TEXT NOT NULL,
    "startTime" TIMESTAMP(3) NOT NULL,
    "endTime" TIMESTAMP(3) NOT NULL,
    "capacity" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "interview_slots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_slot_signups" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "signedUpAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmationStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "confirmationError" TEXT,
    "confirmationSentAt" TIMESTAMP(3),
    "removedBy" TEXT,
    "removedAt" TIMESTAMP(3),

    CONSTRAINT "interview_slot_signups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "interview_slots_interviewId_startTime_idx" ON "interview_slots"("interviewId", "startTime");

-- CreateIndex
CREATE INDEX "interview_slots_endTime_idx" ON "interview_slots"("endTime");

-- CreateIndex
CREATE INDEX "interview_slot_signups_userId_idx" ON "interview_slot_signups"("userId");

-- CreateIndex
CREATE INDEX "interview_slot_signups_removedAt_idx" ON "interview_slot_signups"("removedAt");

-- CreateIndex
CREATE UNIQUE INDEX "interview_slot_signups_slotId_userId_key" ON "interview_slot_signups"("slotId", "userId");

-- AddForeignKey
ALTER TABLE "interview_slots" ADD CONSTRAINT "interview_slots_interviewId_fkey" FOREIGN KEY ("interviewId") REFERENCES "interviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_slot_signups" ADD CONSTRAINT "interview_slot_signups_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "interview_slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_slot_signups" ADD CONSTRAINT "interview_slot_signups_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
