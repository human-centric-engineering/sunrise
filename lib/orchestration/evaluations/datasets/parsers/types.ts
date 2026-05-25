/**
 * Shared types for dataset parsers.
 *
 * Both CSV and JSONL parsers normalise to the same intermediate shape
 * (`ParsedDatasetCase[]`) which the upload handler then validates and
 * writes to `AiDatasetCase` rows. The parser layer does NOT touch the
 * DB — keeping it pure makes the format-specific edge cases (CSV
 * quoting, JSONL line-by-line errors) easy to test in isolation.
 */

/**
 * Intermediate, format-agnostic shape produced by every parser.
 * Field names mirror `AiDatasetCase` columns so the upload handler
 * can map straight through after Zod validation.
 */
export interface ParsedDatasetCase {
  /** Required. Agent subjects expect a string; workflow subjects an object. */
  input: string | Record<string, unknown>;
  /** Optional. Required only by reference-dependent graders. */
  expectedOutput?: string;
  /** Optional. Free-text tags or arbitrary case metadata. */
  metadata?: Record<string, unknown>;
  /** Optional. Ground-truth retrieval contexts for RAG graders (Phase 2). */
  referenceCitations?: unknown[];
}

/** What a parser returns to the upload handler. */
export interface ParsedDataset {
  cases: ParsedDatasetCase[];
  /** Non-fatal warnings (empty rows skipped, columns dropped, etc.). */
  warnings: string[];
}

/** Thrown by parsers when the input is structurally unusable. */
export class DatasetParseError extends Error {
  constructor(
    message: string,
    public readonly lineNumber?: number
  ) {
    super(message);
    this.name = 'DatasetParseError';
  }
}
