-- CreateEnum
CREATE TYPE "MeetingCommunicationType" AS ENUM ('CONFIRMATION', 'HOST_NOTIFICATION', 'CANCELLATION', 'REMINDER');

-- CreateTable
CREATE TABLE "meeting_communications" (
    "id" TEXT NOT NULL,
    "slotId" TEXT NOT NULL,
    "signupId" TEXT,
    "type" "MeetingCommunicationType" NOT NULL,
    "recipient" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "error" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_communications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "meeting_communications_slotId_idx" ON "meeting_communications"("slotId");

-- CreateIndex
CREATE INDEX "meeting_communications_signupId_idx" ON "meeting_communications"("signupId");

-- AddForeignKey
ALTER TABLE "meeting_communications" ADD CONSTRAINT "meeting_communications_slotId_fkey" FOREIGN KEY ("slotId") REFERENCES "meeting_slots"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_communications" ADD CONSTRAINT "meeting_communications_signupId_fkey" FOREIGN KEY ("signupId") REFERENCES "meeting_signups"("id") ON DELETE SET NULL ON UPDATE CASCADE;
