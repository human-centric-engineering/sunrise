-- Phase 1 of flexible-embedding-model support.
--
-- 1. New AiKnowledgeBase grouping above documents; default row seeded so
--    existing documents have a parent to attach to.
-- 2. activeEmbeddingModelId on AiOrchestrationSettings — single source of
--    truth for which model/dim the vector columns are sized for.
-- 3. Provenance fields on AiMessageEmbedding (parity with AiKnowledgeChunk)
--    and an explicit embeddingDimension on AiKnowledgeChunk.
-- 4. Fixes the bug that prompted this work: ai_message_embedding.embedding
--    was declared vector(1024) while the embedder produces 1536-dim vectors.
--    Drops the column (and its HNSW index), recreates it at vector(1536),
--    recreates the index. Truncates the table because the prior column
--    couldn't hold the new vectors anyway; backfill happens lazily via
--    `lib/orchestration/chat/message-embedder.ts`.

-- 1. AiKnowledgeBase table + seeded default row
CREATE TABLE "ai_knowledge_base" (
    "id"          TEXT NOT NULL,
    "slug"        TEXT NOT NULL,
    "name"        TEXT NOT NULL,
    "description" TEXT,
    "isDefault"   BOOLEAN NOT NULL DEFAULT false,
    "createdAt"   TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"   TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ai_knowledge_base_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ai_knowledge_base_slug_key" ON "ai_knowledge_base"("slug");

INSERT INTO "ai_knowledge_base" ("id", "slug", "name", "description", "isDefault", "createdAt", "updatedAt")
VALUES (
    'kb_default',
    'default',
    'Default',
    'Default knowledge base for documents without an explicit corpus assignment',
    true,
    NOW(),
    NOW()
);

-- 2. AiKnowledgeDocument.knowledgeBaseId (backfill to default, then enforce NOT NULL + FK)
ALTER TABLE "ai_knowledge_document" ADD COLUMN "knowledgeBaseId" TEXT;
UPDATE "ai_knowledge_document" SET "knowledgeBaseId" = 'kb_default' WHERE "knowledgeBaseId" IS NULL;
ALTER TABLE "ai_knowledge_document" ALTER COLUMN "knowledgeBaseId" SET NOT NULL;
ALTER TABLE "ai_knowledge_document" ADD CONSTRAINT "ai_knowledge_document_knowledgeBaseId_fkey"
    FOREIGN KEY ("knowledgeBaseId") REFERENCES "ai_knowledge_base"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "ai_knowledge_document_knowledgeBaseId_idx" ON "ai_knowledge_document"("knowledgeBaseId");

-- 3. AiOrchestrationSettings.activeEmbeddingModelId
ALTER TABLE "ai_orchestration_settings" ADD COLUMN "activeEmbeddingModelId" TEXT;
ALTER TABLE "ai_orchestration_settings" ADD CONSTRAINT "ai_orchestration_settings_activeEmbeddingModelId_fkey"
    FOREIGN KEY ("activeEmbeddingModelId") REFERENCES "ai_provider_model"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- 4. AiKnowledgeChunk.embeddingDimension (with conservative backfill for
--    chunks that already have an embeddingModel — current embedder always
--    produces 1536-dim vectors).
ALTER TABLE "ai_knowledge_chunk" ADD COLUMN "embeddingDimension" INTEGER;
UPDATE "ai_knowledge_chunk"
SET "embeddingDimension" = 1536
WHERE "embeddingModel" IS NOT NULL AND "embeddingDimension" IS NULL;

-- 5. Fix ai_message_embedding: drop+recreate column at 1536, add provenance, rebuild HNSW index
DROP INDEX IF EXISTS "idx_message_embedding";
TRUNCATE TABLE "ai_message_embedding";
ALTER TABLE "ai_message_embedding" DROP COLUMN "embedding";
ALTER TABLE "ai_message_embedding" ADD COLUMN "embedding" vector(1536) NOT NULL;
ALTER TABLE "ai_message_embedding" ADD COLUMN "embeddingModel" TEXT;
ALTER TABLE "ai_message_embedding" ADD COLUMN "embeddingProvider" TEXT;
ALTER TABLE "ai_message_embedding" ADD COLUMN "embeddingDimension" INTEGER;

CREATE INDEX "idx_message_embedding" ON "ai_message_embedding"
USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
