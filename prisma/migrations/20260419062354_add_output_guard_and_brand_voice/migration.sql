-- AlterTable
ALTER TABLE "ai_agent" ADD COLUMN     "brandVoiceInstructions" TEXT,
ADD COLUMN     "topicBoundaries" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "ai_orchestration_settings" ADD COLUMN     "outputGuardMode" TEXT DEFAULT 'log_only';
