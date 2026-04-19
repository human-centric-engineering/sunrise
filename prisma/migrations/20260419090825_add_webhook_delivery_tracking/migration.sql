-- CreateTable
CREATE TABLE "ai_webhook_delivery" (
    "id" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "lastResponseCode" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_webhook_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_webhook_delivery_subscriptionId_idx" ON "ai_webhook_delivery"("subscriptionId");

-- CreateIndex
CREATE INDEX "ai_webhook_delivery_status_idx" ON "ai_webhook_delivery"("status");

-- CreateIndex
CREATE INDEX "ai_webhook_delivery_nextRetryAt_idx" ON "ai_webhook_delivery"("nextRetryAt");

-- AddForeignKey
ALTER TABLE "ai_webhook_delivery" ADD CONSTRAINT "ai_webhook_delivery_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "ai_webhook_subscription"("id") ON DELETE CASCADE ON UPDATE CASCADE;
