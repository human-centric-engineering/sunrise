/**
 * Chunker configuration constants.
 *
 * Kept in its own file (separate from `chunker.ts`) so client components
 * can render the values without pulling the chunker — and its transitive
 * embedder + DB-client imports — into the browser bundle.
 *
 * The chunker re-exports these so callers continue to import from
 * `chunker.ts`. Treat this file as the single source of truth.
 */

/** Target chunk size — minimum tokens per chunk before neighbouring sections merge. */
export const MIN_CHUNK_TOKENS = 50;

/** Target chunk size — maximum tokens per chunk before the section is split. */
export const MAX_CHUNK_TOKENS = 800;

/** Rough chars-per-token ratio used by token estimation. */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

/**
 * Trigger for batched CSV processing. Below this row count the CSV
 * chunker runs each row inline; above it, rows are batched to keep
 * embedding API calls below provider rate limits.
 */
export const CSV_ROW_BATCH_THRESHOLD = 5000;

/** Rows per embedding batch when batching kicks in. */
export const CSV_ROWS_PER_BATCH = 10;

/**
 * Per-row character cap. Rows above this length are dropped before
 * embedding (they exceed every embedding API's input limit ≈ 8k tokens)
 * and named in the document warnings.
 */
export const CSV_MAX_ROW_CHARS = 32_000;
