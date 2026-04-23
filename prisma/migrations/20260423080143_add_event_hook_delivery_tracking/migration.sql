-- CreateTable
CREATE TABLE "ai_event_hook_delivery" (
    "id" TEXT NOT NULL,
    "hookId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastAttemptAt" TIMESTAMP(3),
    "nextRetryAt" TIMESTAMP(3),
    "lastResponseCode" INTEGER,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_event_hook_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_event_hook_delivery_hookId_idx" ON "ai_event_hook_delivery"("hookId");

-- CreateIndex
CREATE INDEX "ai_event_hook_delivery_status_idx" ON "ai_event_hook_delivery"("status");

-- CreateIndex
CREATE INDEX "ai_event_hook_delivery_nextRetryAt_idx" ON "ai_event_hook_delivery"("nextRetryAt");

-- AddForeignKey
ALTER TABLE "ai_event_hook_delivery" ADD CONSTRAINT "ai_event_hook_delivery_hookId_fkey" FOREIGN KEY ("hookId") REFERENCES "ai_event_hook"("id") ON DELETE CASCADE ON UPDATE CASCADE;
