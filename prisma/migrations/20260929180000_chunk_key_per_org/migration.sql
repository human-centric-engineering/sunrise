-- Chunk keys are unique per org, not per install (§116 t-726).
--
-- Every org gets its own copy of the platform's patterns knowledge, and the
-- seeded chunks carry fixed keys (`getting_started-main`), so a second copy
-- meets a global UNIQUE (chunkKey) on its first row. The key moves to
-- UNIQUE (orgId, chunkKey), as t-708 moved the slugs
-- (20260921120000_org_scoped_slugs). Uploaded chunks are keyed by their
-- document's id, which is global, so none of theirs collide either way.
--
-- No backfill: the new constraint is implied by the one it replaces. Rows
-- with a NULL orgId are outside every namespace, since Postgres treats
-- NULLs as distinct.

-- DropIndex
DROP INDEX "ai_knowledge_chunk_chunkKey_key";

-- CreateIndex
CREATE UNIQUE INDEX "ai_knowledge_chunk_orgId_chunkKey_key" ON "ai_knowledge_chunk"("orgId", "chunkKey");
