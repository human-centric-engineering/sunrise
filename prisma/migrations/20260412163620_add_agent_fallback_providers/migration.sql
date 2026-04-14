-- AlterTable
ALTER TABLE "ai_agent" ADD COLUMN     "fallbackProviders" TEXT[] DEFAULT ARRAY[]::TEXT[];
