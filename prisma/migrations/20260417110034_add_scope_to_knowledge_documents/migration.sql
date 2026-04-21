-- AlterTable
ALTER TABLE "ai_knowledge_document" ADD COLUMN     "scope" TEXT NOT NULL DEFAULT 'app';

-- Backfill: mark built-in agentic design patterns as system scope
UPDATE "ai_knowledge_document" SET "scope" = 'system' WHERE "fileName" = 'agentic-design-patterns.md';

-- CreateIndex
CREATE INDEX "ai_knowledge_document_scope_idx" ON "ai_knowledge_document"("scope");
