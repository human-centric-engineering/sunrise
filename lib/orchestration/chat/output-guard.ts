/**
 * Output Guard — topic boundary enforcement on assistant responses
 *
 * Scans assistant output for forbidden topic keywords/phrases configured
 * per-agent. Complements the input guard which scans user messages for
 * prompt injection patterns.
 *
 * Like the input guard, this is a **heuristic layer** — it catches
 * obvious boundary violations but determined prompt engineering can
 * still steer the model off-topic. The primary defense is always the
 * system prompt; this guard is a safety net for logging and alerting.
 *
 * The guard also detects common PII patterns (emails, phone numbers,
 * SSNs) that should rarely appear in assistant output regardless of
 * agent configuration.
 */

export interface OutputScanResult {
  flagged: boolean;
  /** Which forbidden topics matched. */
  topicMatches: string[];
  /** Which built-in patterns matched (e.g. 'pii_email'). */
  builtInMatches: string[];
}

interface BuiltInPattern {
  label: string;
  regex: RegExp;
}

/**
 * Built-in patterns that apply to all agents regardless of configuration.
 * These catch common PII leaks in assistant output.
 */
const BUILT_IN_PATTERNS: BuiltInPattern[] = [
  {
    label: 'pii_email',
    regex: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/,
  },
  {
    label: 'pii_phone',
    regex: /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)?\d{3}[-.\s]?\d{4}\b/,
  },
  {
    label: 'pii_ssn',
    regex: /\b\d{3}-\d{2}-\d{4}\b/,
  },
  {
    label: 'pii_credit_card',
    regex: /\b(?:\d{4}[-\s]?){3}\d{4}\b/,
  },
];

/**
 * Scan an assistant response against per-agent topic boundaries
 * and built-in PII patterns.
 *
 * @param content - The assistant response text
 * @param topicBoundaries - Forbidden keywords/phrases from the agent config.
 *   Each entry is matched case-insensitively as a word-boundary substring.
 */
export function scanOutput(content: string, topicBoundaries: string[]): OutputScanResult {
  const lower = content.toLowerCase();

  const topicMatches: string[] = [];
  for (const topic of topicBoundaries) {
    const trimmed = topic.trim();
    if (trimmed.length === 0) continue;
    // Case-insensitive substring match — word boundary where possible
    if (lower.includes(trimmed.toLowerCase())) {
      topicMatches.push(trimmed);
    }
  }

  const builtInMatches: string[] = [];
  for (const pattern of BUILT_IN_PATTERNS) {
    if (pattern.regex.test(content)) {
      builtInMatches.push(pattern.label);
    }
  }

  return {
    flagged: topicMatches.length > 0 || builtInMatches.length > 0,
    topicMatches,
    builtInMatches,
  };
}

/**
 * Result of {@link scanCitations}.
 */
export interface CitationScanResult {
  flagged: boolean;
  /** True when citations were available but no marker appears in the text. */
  underCited: boolean;
  /** Marker numbers referenced via `[N]` that have no matching citation. */
  hallucinatedMarkers: number[];
}

/** Matches `[1]`, `[2]`, …, `[42]` etc. anywhere in the text. */
const CITATION_MARKER_PATTERN = /\[(\d+)\]/g;

/**
 * Scan an assistant response for citation hygiene against the
 * citations envelope produced during the turn. Two failure modes are
 * detected:
 *
 * - **Under-citation**: citations exist but no `[N]` marker appears in
 *   the text. Implies the model retrieved sources but failed to ground.
 * - **Hallucinated marker**: a `[N]` marker appears in the text but no
 *   citation in the envelope carries that marker.
 *
 * Returns `flagged: false` when there are no citations (vacuously
 * passing — the model wasn't required to cite anything) or when at
 * least one valid marker is referenced and no invalid markers appear.
 *
 * Heuristic, not exhaustive: a model can still under-cite by quoting
 * one source but making five claims. Tighter checks (sentence-level
 * marker density, semantic faithfulness scoring) belong in named
 * evaluation metrics, not this regex pass.
 */
export function scanCitations(
  content: string,
  citations: ReadonlyArray<{ marker: number }>
): CitationScanResult {
  if (citations.length === 0) {
    return { flagged: false, underCited: false, hallucinatedMarkers: [] };
  }

  const validMarkers = new Set(citations.map((c) => c.marker));
  const referencedMarkers = new Set<number>();
  const hallucinated = new Set<number>();

  for (const match of content.matchAll(CITATION_MARKER_PATTERN)) {
    const n = Number.parseInt(match[1], 10);
    if (validMarkers.has(n)) {
      referencedMarkers.add(n);
    } else {
      hallucinated.add(n);
    }
  }

  const underCited = referencedMarkers.size === 0;
  return {
    flagged: underCited || hallucinated.size > 0,
    underCited,
    hallucinatedMarkers: [...hallucinated].sort((a, b) => a - b),
  };
}
