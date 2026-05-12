-- Phase 1 of the knowledge-access-control feature.
-- Additive only: introduces a managed tag taxonomy, three join tables, an access-mode column
-- on AiAgent, and an MCP-key→agent binding. Legacy columns (knowledgeCategories,
-- AiKnowledgeDocument.category, AiKnowledgeChunk.category) stay in place; backfill is run
-- by scripts/backfill-knowledge-tags.ts. Legacy columns drop in Phase 6.

-- 1. Agent access mode (default 'full' preserves prior behaviour for all existing agents).
ALTER TABLE "ai_agent" ADD COLUMN "knowledgeAccessMode" TEXT NOT NULL DEFAULT 'full';

-- 2. Managed tag taxonomy.
CREATE TABLE "knowledge_tag" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "knowledge_tag_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "knowledge_tag_slug_key" ON "knowledge_tag"("slug");

-- 3. Document ↔ tag join (a document can carry many tags; a tag covers many documents).
CREATE TABLE "ai_knowledge_document_tag" (
    "documentId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_knowledge_document_tag_pkey" PRIMARY KEY ("documentId", "tagId")
);

CREATE INDEX "ai_knowledge_document_tag_tagId_idx" ON "ai_knowledge_document_tag"("tagId");

ALTER TABLE "ai_knowledge_document_tag"
    ADD CONSTRAINT "ai_knowledge_document_tag_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "ai_knowledge_document"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_knowledge_document_tag"
    ADD CONSTRAINT "ai_knowledge_document_tag_tagId_fkey"
    FOREIGN KEY ("tagId") REFERENCES "knowledge_tag"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 4. Agent ↔ document grants (only consulted when knowledgeAccessMode = 'restricted').
CREATE TABLE "ai_agent_knowledge_document" (
    "agentId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_knowledge_document_pkey" PRIMARY KEY ("agentId", "documentId")
);

CREATE INDEX "ai_agent_knowledge_document_documentId_idx" ON "ai_agent_knowledge_document"("documentId");

ALTER TABLE "ai_agent_knowledge_document"
    ADD CONSTRAINT "ai_agent_knowledge_document_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_agent_knowledge_document"
    ADD CONSTRAINT "ai_agent_knowledge_document_documentId_fkey"
    FOREIGN KEY ("documentId") REFERENCES "ai_knowledge_document"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 5. Agent ↔ tag grants (only consulted when knowledgeAccessMode = 'restricted').
CREATE TABLE "ai_agent_knowledge_tag" (
    "agentId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ai_agent_knowledge_tag_pkey" PRIMARY KEY ("agentId", "tagId")
);

CREATE INDEX "ai_agent_knowledge_tag_tagId_idx" ON "ai_agent_knowledge_tag"("tagId");

ALTER TABLE "ai_agent_knowledge_tag"
    ADD CONSTRAINT "ai_agent_knowledge_tag_agentId_fkey"
    FOREIGN KEY ("agentId") REFERENCES "ai_agent"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ai_agent_knowledge_tag"
    ADD CONSTRAINT "ai_agent_knowledge_tag_tagId_fkey"
    FOREIGN KEY ("tagId") REFERENCES "knowledge_tag"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- 6. MCP API key → agent binding. Null means "unscoped service key" (system-wide access).
-- New keys created via the admin UI will default to scoped-to-an-agent; existing keys keep null
-- so they continue to behave as today until an operator deliberately scopes them.
ALTER TABLE "mcp_api_key" ADD COLUMN "scopedAgentId" TEXT;

CREATE INDEX "mcp_api_key_scopedAgentId_idx" ON "mcp_api_key"("scopedAgentId");

ALTER TABLE "mcp_api_key"
    ADD CONSTRAINT "mcp_api_key_scopedAgentId_fkey"
    FOREIGN KEY ("scopedAgentId") REFERENCES "ai_agent"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;
