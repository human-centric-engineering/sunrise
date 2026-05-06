-- AlterTable
ALTER TABLE "ai_orchestration_settings" ADD COLUMN     "embedAllowedOrigins" JSONB NOT NULL DEFAULT '[]';
