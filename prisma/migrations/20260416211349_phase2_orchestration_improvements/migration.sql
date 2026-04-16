-- AlterTable
ALTER TABLE "ai_capability" ADD COLUMN     "approvalTimeoutMs" INTEGER;

-- AlterTable
ALTER TABLE "ai_conversation" ADD COLUMN     "summary" TEXT,
ADD COLUMN     "summaryUpToMessageId" TEXT;

-- AlterTable
ALTER TABLE "ai_orchestration_settings" ADD COLUMN     "approvalDefaultAction" TEXT DEFAULT 'deny',
ADD COLUMN     "defaultApprovalTimeoutMs" INTEGER,
ADD COLUMN     "inputGuardMode" TEXT DEFAULT 'log_only';

-- AlterTable
ALTER TABLE "ai_provider_config" ADD COLUMN     "maxRetries" INTEGER,
ADD COLUMN     "timeoutMs" INTEGER;
