-- Slugs are unique per org, not per install (§107 t-708).
--
-- AiAgent, AiKnowledgeBase and AiKnowledgeDocument move from a global
-- UNIQUE (slug) to UNIQUE (orgId, slug), so two orgs can each hold an
-- agent called `support`. AiWorkflow.slug stays global: it is the
-- unauthenticated inbound URL segment (journal decision on §107).
--
-- Two partial uniques Prisma cannot model move the same way, re-created
-- here by hand (A5 and A7 in scripts/db/check-drift.ts): the ready-document
-- dedupe becomes (orgId, fileHash) — otherwise the second org to upload a
-- file the first already holds fails at the end of ingestion with a
-- violation from a table it cannot see into — and "one default knowledge
-- base" becomes one per org, which is what lets every org's first upload
-- create its own.
--
-- No backfill: every constraint here is implied by the one it replaces.
-- Rows with a NULL orgId — only a create under runAsSystem leaves one —
-- are outside every namespace, since Postgres treats NULLs as distinct.

-- DropIndex
DROP INDEX "ai_agent_slug_key";

-- DropIndex
DROP INDEX "ai_knowledge_base_slug_key";

-- DropIndex
DROP INDEX "ai_knowledge_document_slug_key";

-- CreateIndex
CREATE UNIQUE INDEX "ai_agent_orgId_slug_key" ON "ai_agent"("orgId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "ai_knowledge_base_orgId_slug_key" ON "ai_knowledge_base"("orgId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "ai_knowledge_document_orgId_slug_key" ON "ai_knowledge_document"("orgId", "slug");

-- Prisma-unmodelled (A5): the ready-document dedupe, now per org.
DROP INDEX "idx_knowledge_doc_file_hash_ready";
CREATE UNIQUE INDEX "idx_knowledge_doc_file_hash_ready"
  ON "ai_knowledge_document" ("orgId", "fileHash")
  WHERE "status" = 'ready';

-- Prisma-unmodelled (A7): one default knowledge base PER ORG.
DROP INDEX "idx_ai_knowledge_base_single_default";
CREATE UNIQUE INDEX "idx_ai_knowledge_base_single_default"
  ON "ai_knowledge_base" ("orgId")
  WHERE "isDefault" = true;
