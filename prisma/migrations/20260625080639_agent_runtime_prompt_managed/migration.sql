-- AlterTable
-- Advisory honesty flag (+ optional operator note) for agents whose system
-- prompt is built in application code per call rather than read from the
-- stored instruction fields. App-populated and behaviour-neutral; drives only
-- the admin Instructions-tab callout. See GitHub issue #304.
--
-- Hand-folded: `prisma migrate dev` also emitted DROP INDEX / ALTER COLUMN
-- statements against the baseline-managed pgvector & tsvector objects
-- (idx_knowledge_embedding, idx_message_embedding,
-- idx_ai_knowledge_chunk_search_vector, ai_knowledge_chunk.searchVector).
-- Those are raw-SQL baseline objects Prisma can't model, so they surface as
-- perpetual drift on every migrate dev and must be stripped — matching the
-- clean prior migrations in this directory.
ALTER TABLE "ai_agent" ADD COLUMN     "runtimePromptManaged" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "runtimePromptNote" TEXT;
