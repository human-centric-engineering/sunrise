# Prisma-unmodelled DB objects

A complete inventory of the Postgres objects Sunrise's baseline migration creates that the Prisma schema **cannot model**. Each one is managed via raw SQL in `prisma/migrations/00000000000000_baseline/migration.sql`; each is at risk of being silently dropped by future `prisma migrate dev` runs unless the generated SQL is inspected.

This doc is the canonical reference. `npm run db:drift-check` probes every row in the table below.

## Why these objects need special handling

The Prisma schema describes tables, columns (with a subset of types), simple indexes, and a small set of constraint kinds (`@unique`, `@@unique`, `@id`). It does **not** model:

- **GENERATED ALWAYS columns** — computed at write-time by Postgres from a SQL expression
- **GIN / GiST / HNSW / BRIN indexes** — only B-tree is expressed via `@@index`
- **Partial indexes** (`CREATE INDEX … WHERE …`)
- **CHECK constraints**

When `prisma migrate dev` diffs the schema against a deployed DB that contains any of these, it sees an "unknown" object and emits `DROP` statements in the generated SQL. Running that DDL silently breaks search, embedding, dedupe, or referential integrity — the schema-only test suite never notices because Prisma queries don't depend on these objects.

The mitigation is **inspect-before-apply**: every schema-folded migration's generated SQL must be hand-edited to strip the DROP lines before being applied. The drift-warning blocks above each affected model in `prisma/schema/` are the visible reminder; this doc is the canonical inventory.

## Inventory

All objects below are defined in `prisma/migrations/00000000000000_baseline/migration.sql` unless noted. The `Drop-check SQL` column is exactly what `scripts/db/check-drift.ts` runs.

| ID  | Name                                        | Kind                      | Table                   | Drop-check SQL                                                                                                                          |
| --- | ------------------------------------------- | ------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | `searchVector`                              | GENERATED tsvector column | `ai_knowledge_chunk`    | `SELECT 1 FROM information_schema.columns WHERE table_name = 'ai_knowledge_chunk' AND column_name = 'searchVector'`                     |
| A2  | `idx_ai_knowledge_chunk_search_vector`      | GIN index                 | `ai_knowledge_chunk`    | `SELECT 1 FROM pg_indexes WHERE indexname = 'idx_ai_knowledge_chunk_search_vector'`                                                     |
| A3  | `idx_knowledge_embedding`                   | HNSW index (pgvector)     | `ai_knowledge_chunk`    | `SELECT 1 FROM pg_indexes WHERE indexname = 'idx_knowledge_embedding'`                                                                  |
| A4  | `idx_message_embedding`                     | HNSW index (pgvector)     | `ai_message_embedding`  | `SELECT 1 FROM pg_indexes WHERE indexname = 'idx_message_embedding'`                                                                    |
| A5  | `idx_knowledge_doc_file_hash_ready`         | partial unique index      | `ai_knowledge_document` | `SELECT 1 FROM pg_indexes WHERE indexname = 'idx_knowledge_doc_file_hash_ready'`                                                        |
| A6  | `ai_workflow_execution_lease_pair_coherent` | CHECK constraint          | `ai_workflow_execution` | `SELECT 1 FROM pg_constraint WHERE conname = 'ai_workflow_execution_lease_pair_coherent' AND pg_get_constraintdef(oid) LIKE '%length%'` |
| A7  | `idx_ai_knowledge_base_single_default`      | partial unique index      | `ai_knowledge_base`     | `SELECT 1 FROM pg_indexes WHERE indexname = 'idx_ai_knowledge_base_single_default'`                                                     |
| A8  | `ai_knowledge_document_status_lowercase`    | CHECK constraint          | `ai_knowledge_document` | `SELECT 1 FROM pg_constraint WHERE conname = 'ai_knowledge_document_status_lowercase'`                                                  |
| —   | `english` tsearch configuration             | `pg_ts_config` row        | (system)                | `SELECT 1 FROM pg_ts_config WHERE cfgname = 'english'`                                                                                  |

### Per-object purpose

- **A1 `searchVector`** — `tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, '') || ' ' || coalesce(keywords, ''))) STORED`. Powers hybrid search (lexical + vector). Drop → lexical search returns empty everywhere; UI shows zero results for any non-embedded query.
- **A2 GIN index** on `searchVector`. Drop → lexical lookups full-table-scan; latency explodes on any non-trivial corpus.
- **A3 HNSW index** on `ai_knowledge_chunk.embedding`. Drop → vector-similarity ORDER BY falls back to brute-force scan; retrieval that's normally < 20 ms becomes seconds.
- **A4 HNSW index** on `ai_message_embedding.embedding`. Same shape as A3 for conversational memory retrieval.
- **A5 partial unique** `(fileHash) WHERE status = 'ready'`. Allows retrying a failed upload of the same content without manual cleanup, but blocks two concurrent successful uploads of the same content from creating duplicate ready rows. Drop → duplicate ready rows accumulate; admin UI shows fake "two copies" of the same document.
- **A6 lease-pair CHECK**. `(leaseToken IS NULL) = (leaseExpiresAt IS NULL)` plus `leaseToken IS NULL OR length(leaseToken) > 0`. Enforces the worker-lease invariant: a row either has both lease columns set (and the token is non-empty) or neither. Drop → orphan-sweep can leave rows with `leaseToken` set but no `leaseExpiresAt`; the sweep filters on `leaseExpiresAt < now()` so those rows are permanently stuck. The tightened predicate also blocks empty-string tokens that leak through `if (!leaseToken)` early returns.
- **A7 single-default partial unique** `(isDefault) WHERE isDefault = true`. At most one row may carry the default flag — the runtime invariant `getOrCreateDefaultKnowledgeBase()` and every upload path depend on. Drop → uploading code keeps going if a second `isDefault=true` row is created (e.g. by an admin SQL fix gone wrong), but new documents may route to whichever default the upsert happens to find by slug-natural-key.
- **A8 status casing CHECK**. Pins `ai_knowledge_document.status` to `('processing', 'ready', 'failed', 'pending_review')`. Catches typos / casing drift (`'Ready'` vs `'ready'`) from raw-SQL or direct-DB writes before they corrupt the upload state machine. Drop → divergent values silently break the admin UI filter and the upload status machine.
- **`english` tsearch config** — the GENERATED expression on A1 references `to_tsvector('english', …)`. A custom or locale-stripped Postgres install can lack it, which turns the generated expression into a runtime error on every chunk insert (write-time failure, not load-time). Worth checking before first deploy.

## How to run the drift check

```bash
npm run db:drift-check
```

Output:

- `OK    A1 …` — green for each present object
- `FAIL  AN …` — red for each missing object, identifying the kind and table
- Exit 0 if all 9 probes pass, exit 1 if any failed, exit 2 on script crash

Recommended use:

- **Post-deploy gate** — run after every production migrate-deploy
- **Pre-fork sanity** — fork install hits this before serving traffic
- **CI guard** — any PR that touches `prisma/` should run this in CI against a freshly-baselined scratch DB

## Adding a new unmodelled object

When a future change requires a Postgres feature Prisma can't model:

1. **Pick the next ID** — A9, A10, etc.
2. **Add the raw SQL** to the baseline migration (or a new migration if the baseline is closed). Comment it with a heading block matching the existing A6/A7/A8 format: ID, what it enforces, why it can't be Prisma-modelled, source.
3. **Add a drift-warning comment block** above the affected `model` in `prisma/schema/`. The block must spell out the invariant in prose and warn that `prisma migrate dev` will emit DROP statements for it. Source-of-truth line must point at the baseline path.
4. **Add a row to the inventory table above** with the drop-check SQL.
5. **Add an entry to `DRIFT_OBJECTS` in `scripts/db/check-drift.ts`** so `npm run db:drift-check` probes it.
6. **Add a per-object purpose paragraph** in the section above.

The drift-warning block on the model + the row in this table + the probe in the script are the three places that must agree. Missing any one is how an object goes silently un-tracked and gets dropped on the next schema-folded `migrate dev`.

## Related

- `prisma/migrations/00000000000000_baseline/migration.sql` — definitions
- `prisma/schema/` — drift-warning blocks above each affected model
- `scripts/db/check-drift.ts` — runtime probes
- `.context/database/prisma-7-baseline-bugs.md` — generator bugs the baseline also hand-folds (B-series, distinct from this A-series)
- `.context/database/migrations.md` — migration workflow (general)
