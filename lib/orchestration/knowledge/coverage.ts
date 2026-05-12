/**
 * Text-capture coverage metric.
 *
 * After chunking, compares the byte count of the source text that went
 * into the chunker against the byte count of all stored chunks. A low
 * ratio means the chunker dropped or aggressively trimmed content
 * (oversize CSV rows above the per-row cap, paragraph-splits that emit
 * empty fragments, etc.) — useful as a one-glance sanity check that
 * "everything we parsed made it into the knowledge base".
 *
 * The percentage is intentionally allowed to exceed 100: heading-aware
 * chunking can repeat section titles inside each child chunk, and the
 * markdown chunker also injects `<!-- metadata: ... -->` comments. We
 * cap warnings at the low end only — over-coverage is not a quality
 * signal, only under-coverage is.
 */

/** Threshold below which the coverage warning is emitted. */
export const COVERAGE_WARNING_THRESHOLD = 95;

export interface CoverageMetric {
  /** Length of the text fed into the chunker. */
  parsedChars: number;
  /** Sum of all chunk content lengths. */
  chunkChars: number;
  /** Ratio chunkChars / parsedChars, expressed 0–100+, rounded to 1 dp. */
  coveragePct: number;
  // Index signature lets the metric drop straight into Prisma's
  // `InputJsonObject` shape without a `JSON.stringify` round-trip.
  [key: string]: number;
}

/**
 * Compute coverage from a source string and the chunk contents the
 * chunker produced. Whitespace-only differences (the chunker frequently
 * trims surrounding whitespace) are normalised by comparing trimmed
 * lengths.
 */
export function computeCoverage(
  parsedText: string,
  chunkContents: ReadonlyArray<string>
): CoverageMetric {
  const parsedChars = parsedText.trim().length;
  const chunkChars = chunkContents.reduce((acc, c) => acc + c.trim().length, 0);
  // Guard against divide-by-zero: an empty document has 100% coverage by
  // definition (there was nothing to capture, so nothing was dropped).
  const coveragePct = parsedChars === 0 ? 100 : Math.round((chunkChars / parsedChars) * 1000) / 10;
  return { parsedChars, chunkChars, coveragePct };
}

/**
 * Returns a single warning string when coverage is suspiciously low, or
 * null when it's within range. Callers append to `warnings[]` so the
 * message shows alongside parser warnings in the admin UI.
 */
export function buildCoverageWarning(metric: CoverageMetric): string | null {
  if (metric.coveragePct >= COVERAGE_WARNING_THRESHOLD) return null;
  return (
    `Only ${metric.coveragePct}% of the parsed text was captured in chunks ` +
    `(${metric.chunkChars.toLocaleString()} of ${metric.parsedChars.toLocaleString()} chars). ` +
    `Some content may have been dropped — review the chunks below.`
  );
}
