-- CreateTable
CREATE TABLE "campaign_send_log_resolutions" (
    "id" TEXT NOT NULL,
    "logId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "campaign_send_log_resolutions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "campaign_send_log_resolutions_logId_idx" ON "campaign_send_log_resolutions"("logId");

-- CreateIndex
CREATE INDEX "campaign_send_log_resolutions_actorId_idx" ON "campaign_send_log_resolutions"("actorId");

-- AddForeignKey
ALTER TABLE "campaign_send_log_resolutions" ADD CONSTRAINT "campaign_send_log_resolutions_logId_fkey" FOREIGN KEY ("logId") REFERENCES "campaign_send_logs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "campaign_send_log_resolutions" ADD CONSTRAINT "campaign_send_log_resolutions_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
