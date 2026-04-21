-- AlterTable
ALTER TABLE "ai_agent" ADD COLUMN     "knowledgeCategories" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "ai_knowledge_document" ADD COLUMN     "category" TEXT;

-- CreateIndex
CREATE INDEX "ai_knowledge_document_category_idx" ON "ai_knowledge_document"("category");
