-- AlterTable
ALTER TABLE "ai_orchestration_settings" ADD COLUMN     "costLogRetentionDays" INTEGER,
ADD COLUMN     "maxConversationsPerUser" INTEGER,
ADD COLUMN     "maxMessagesPerConversation" INTEGER,
ADD COLUMN     "webhookRetentionDays" INTEGER;

-- CreateIndex
CREATE INDEX "ai_conversation_updatedAt_idx" ON "ai_conversation"("updatedAt");

-- CreateIndex
CREATE INDEX "ai_cost_log_agentId_createdAt_idx" ON "ai_cost_log"("agentId", "createdAt");

-- CreateIndex
CREATE INDEX "ai_message_conversationId_createdAt_idx" ON "ai_message"("conversationId", "createdAt");

-- HNSW index for fast approximate nearest neighbor search on message embeddings.
-- Mirrors the existing idx_knowledge_embedding on ai_knowledge_chunk.
-- Uses cosine distance (vector_cosine_ops) to match the <=> operator used in search.
CREATE INDEX idx_message_embedding ON ai_message_embedding
USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
