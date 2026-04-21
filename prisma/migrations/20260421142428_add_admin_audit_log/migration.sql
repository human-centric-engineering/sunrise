-- CreateTable
CREATE TABLE "ai_admin_audit_log" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "entityName" TEXT,
    "changes" JSONB,
    "metadata" JSONB,
    "clientIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_admin_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ai_admin_audit_log_userId_idx" ON "ai_admin_audit_log"("userId");

-- CreateIndex
CREATE INDEX "ai_admin_audit_log_action_idx" ON "ai_admin_audit_log"("action");

-- CreateIndex
CREATE INDEX "ai_admin_audit_log_entityType_entityId_idx" ON "ai_admin_audit_log"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "ai_admin_audit_log_createdAt_idx" ON "ai_admin_audit_log"("createdAt");

-- AddForeignKey
ALTER TABLE "ai_admin_audit_log" ADD CONSTRAINT "ai_admin_audit_log_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
