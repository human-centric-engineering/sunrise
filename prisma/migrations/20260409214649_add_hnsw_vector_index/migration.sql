-- HNSW index for fast approximate nearest neighbor search on knowledge chunk embeddings
-- Uses cosine distance operator (vector_cosine_ops) matching the <=> operator used in search queries
-- m=16: max connections per node, ef_construction=64: build-time search width
CREATE INDEX idx_knowledge_embedding ON ai_knowledge_chunk
USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
