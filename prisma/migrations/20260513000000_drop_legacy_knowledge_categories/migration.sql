-- Phase 6 of the knowledge-access-control feature.
-- Drops the three legacy columns that were superseded by the managed
-- tag taxonomy (knowledge_tag + ai_agent_knowledge_tag joins) and the
-- knowledgeAccessMode column added in Phase 1. The resolver has ignored
-- these columns since Phase 2 and no UI surface reads or writes them
-- today, so this is purely a tidy-up.
--
--   * ai_agent.knowledgeCategories      — replaced by AiAgentKnowledgeTag joins.
--   * ai_knowledge_document.category    — replaced by AiKnowledgeDocumentTag joins.
--   * ai_knowledge_chunk.category       — was metadata only; not used for scoping.
--
-- Indexes on the dropped columns are removed first to keep the DDL
-- self-contained (DROP COLUMN would drop them implicitly, but listing
-- them up front makes the intent obvious in code review).

DROP INDEX IF EXISTS "ai_knowledge_document_category_idx";
DROP INDEX IF EXISTS "ai_knowledge_chunk_category_idx";

ALTER TABLE "ai_agent" DROP COLUMN IF EXISTS "knowledgeCategories";
ALTER TABLE "ai_knowledge_document" DROP COLUMN IF EXISTS "category";
ALTER TABLE "ai_knowledge_chunk" DROP COLUMN IF EXISTS "category";
