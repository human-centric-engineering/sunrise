-- A knowledge chunk's place in its document (t-1106). Nullable, no backfill:
-- an existing row's document order cannot be recovered from its chunkKey (the
-- `-N` suffix restarts in each section), so those rows keep the old suffix
-- sort until the document is re-chunked, which writes every row's position.
ALTER TABLE "ai_knowledge_chunk" ADD COLUMN "position" INTEGER;
