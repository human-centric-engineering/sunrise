-- t-1016 (§127): when the LLM privacy layer last refused to embed a reply.
--
-- Nullable, and null for every existing message. The embedding backfill reads
-- replies never refused first and retries a refused one only after a
-- back-off, so refusals cannot fill its batch and hold older replies back.

-- AlterTable
ALTER TABLE "ai_message" ADD COLUMN     "embeddingRefusedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "ai_message_embeddingRefusedAt_idx" ON "ai_message"("embeddingRefusedAt");
