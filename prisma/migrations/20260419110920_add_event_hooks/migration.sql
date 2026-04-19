-- CreateTable
CREATE TABLE "ai_event_hook" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "eventType" VARCHAR(100) NOT NULL,
    "action" JSONB NOT NULL,
    "filter" JSONB,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_event_hook_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_event_hook_eventType_idx" ON "ai_event_hook"("eventType");

-- CreateIndex
CREATE INDEX "ai_event_hook_isEnabled_idx" ON "ai_event_hook"("isEnabled");

-- AddForeignKey
ALTER TABLE "ai_event_hook" ADD CONSTRAINT "ai_event_hook_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
