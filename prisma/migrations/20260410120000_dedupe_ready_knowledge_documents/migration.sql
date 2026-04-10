-- Partial unique index to prevent duplicate "ready" knowledge documents with the same content hash.
-- Failed uploads are intentionally excluded so a caller can retry after a processing error.
-- Application-level dedup in uploadDocument() checks findFirst() before creating; this index is
-- the belt-and-braces safeguard against concurrent uploads racing past the application check.
CREATE UNIQUE INDEX "idx_knowledge_doc_file_hash_ready"
ON "ai_knowledge_document" ("fileHash")
WHERE "status" = 'ready';
