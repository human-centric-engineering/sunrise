-- Generated tsvector column over content + keywords for hybrid (BM25-flavoured + vector) search.
-- Postgres auto-populates this column on INSERT/UPDATE; no application code touches it.
ALTER TABLE "ai_knowledge_chunk"
  ADD COLUMN "searchVector" tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english', coalesce(content, '') || ' ' || coalesce(keywords, ''))
  ) STORED;

-- GIN index used by ts_rank_cd / @@ matching when hybridEnabled is true.
CREATE INDEX "idx_ai_knowledge_chunk_search_vector"
  ON "ai_knowledge_chunk" USING GIN ("searchVector");
