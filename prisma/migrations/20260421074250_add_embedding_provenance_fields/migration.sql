-- DropIndex
DROP INDEX "idx_message_embedding";

-- AlterTable
ALTER TABLE "ai_knowledge_chunk" ADD COLUMN     "embeddedAt" TIMESTAMP(3),
ADD COLUMN     "embeddingModel" TEXT,
ADD COLUMN     "embeddingProvider" TEXT;
