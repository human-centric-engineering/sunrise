/**
 * Dataset content hashing.
 *
 * A stable SHA-256 over the normalised case array — positions sorted,
 * each case canonicalised (sorted keys, undefined fields stripped).
 * Used by:
 *
 *   1. `AiDataset.contentHash` — pinned when an upload writes rows.
 *   2. `AiEvaluationRun.datasetContentHash` — captured at submit time.
 *      The worker re-hashes on claim; mismatch ⇒ fail the run with
 *      `summary.note = 'dataset_changed_post_submit'`.
 *
 * This is *not* a fingerprint of every byte of the source file (the
 * raw CSV or JSONL may have varied whitespace, BOMs, etc.). It's a
 * fingerprint of the data that ended up in `AiDatasetCase` rows.
 */

import { createHash } from 'node:crypto';
import type { ParsedDatasetCase } from '@/lib/orchestration/evaluations/datasets/parsers/types';

/** A case with a position assigned (post-write). */
export interface HashableCase {
  position: number;
  input: unknown;
  expectedOutput?: string | null;
  metadata?: unknown;
  referenceCitations?: unknown;
}

/** Recursively sort object keys so JSON stringification is deterministic. */
function canonicalise(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalise);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      if (obj[key] === undefined) continue;
      out[key] = canonicalise(obj[key]);
    }
    return out;
  }
  return value;
}

export function hashDatasetCases(cases: readonly HashableCase[]): string {
  const sorted = [...cases].sort((a, b) => a.position - b.position);
  const normalised = sorted.map((c) => ({
    position: c.position,
    input: canonicalise(c.input),
    expectedOutput: c.expectedOutput ?? null,
    metadata: c.metadata !== undefined ? canonicalise(c.metadata) : null,
    referenceCitations:
      c.referenceCitations !== undefined ? canonicalise(c.referenceCitations) : null,
  }));
  const json = JSON.stringify(normalised);
  return createHash('sha256').update(json).digest('hex');
}

/**
 * Convenience: hash parser output BEFORE positions exist. Assumes the
 * array order is the canonical order (parsers return cases in file
 * order). Used at upload time to pre-compute the hash from
 * ParsedDatasetCase[] without first writing rows.
 */
export function hashParsedCases(cases: readonly ParsedDatasetCase[]): string {
  return hashDatasetCases(cases.map((c, i) => ({ position: i, ...c })));
}
