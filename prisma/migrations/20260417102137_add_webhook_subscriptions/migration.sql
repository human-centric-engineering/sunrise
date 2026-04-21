-- CreateTable
CREATE TABLE "ai_webhook_subscription" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "events" TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "description" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_webhook_subscription_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_webhook_subscription_isActive_idx" ON "ai_webhook_subscription"("isActive");

-- AddForeignKey
ALTER TABLE "ai_webhook_subscription" ADD CONSTRAINT "ai_webhook_subscription_createdBy_fkey" FOREIGN KEY ("createdBy") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
