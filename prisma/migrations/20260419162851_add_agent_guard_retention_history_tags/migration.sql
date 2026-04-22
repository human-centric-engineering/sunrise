-- AlterTable
ALTER TABLE "ai_agent" ADD COLUMN     "inputGuardMode" TEXT,
ADD COLUMN     "maxHistoryTokens" INTEGER,
ADD COLUMN     "outputGuardMode" TEXT,
ADD COLUMN     "retentionDays" INTEGER;

-- AlterTable
ALTER TABLE "ai_conversation" ADD COLUMN     "tags" TEXT[] DEFAULT ARRAY[]::TEXT[];
