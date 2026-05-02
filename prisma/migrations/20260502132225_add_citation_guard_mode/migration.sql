-- AlterTable
ALTER TABLE "ai_agent" ADD COLUMN     "citationGuardMode" TEXT;

-- AlterTable
ALTER TABLE "ai_orchestration_settings" ADD COLUMN     "citationGuardMode" TEXT DEFAULT 'log_only';
