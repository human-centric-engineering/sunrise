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
 * The guard also flags identifiers in the reply — email addresses, phone
 * numbers, NI and NHS numbers, card and bank details, keys — using the LLM
 * privacy layer's tier A rules through its registry (§127), and ignores any
 * the conversation itself supplied: a reply that repeats the user's own email
 * back to them, or one the privacy layer restored, is not a leak.
 */
import type { LlmMessage } from '@/lib/orchestration/llm/types';
import { messagePieces } from '@/lib/orchestration/privacy/call-masking';
import { CORE_RULES_DETECTOR_ID } from '@/lib/privacy/adapters/core-defaults';
import { logger } from '@/lib/logging';
import { getPrivacyAdapters } from '@/lib/privacy/adapters/registry';
import { runPrivacyDetectors } from '@/lib/privacy/adapters/run';

export interface OutputScanResult {
  flagged: boolean;
  /** Which forbidden topics matched. */
  topicMatches: string[];
  /**
   * Which kinds of identifier the reply contained that the conversation did
   * not supply, as `pii_<type>` (e.g. `pii_email`, `pii_uk_nino`).
   */
  builtInMatches: string[];
}

/**
 * How long the identifier scan may take. A reply is short, so this is
 * generous; a scan that runs out flags nothing rather than holding the turn.
 */
const OUTPUT_SCAN_TIMEOUT_MS = 2_000;

/** Characters people write inside an identifier: spaces and `- . ( ) /`. */
const SEPARATORS = '[\\s\\-.()/]*';

const ALNUM = '[\\p{L}\\p{N}]';

/**
 * A pattern for `value` as people write it: any of the usual separators may
 * sit between its characters ("07700 900123", "(07700) 900-123"), case is
 * ignored, and it must stand on its own — no letter or digit right before or
 * after it — so a sort code is not "supplied" because its digits sit inside a
 * longer reference number.
 */
function writtenAs(value: string): RegExp | null {
  const chars = [...value.toLowerCase()].filter((c) => !/[\s\-.()/]/.test(c));
  if (chars.length === 0) return null;
  const body = chars.map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(SEPARATORS);
  return new RegExp(`(?<!${ALNUM})${body}(?!${ALNUM})`, 'iu');
}

/**
 * The ids to run for the guard: `core.rules`, or the app detector that
 * replaced it, when it runs on this server or on infrastructure the operator
 * controls. An `external` replacement is left out: the guard runs in every
 * privacy mode, `off` included, and would post every reply to a service no
 * setting sent it to.
 */
function guardDetectorIds(): string[] {
  return getPrivacyAdapters()
    .detectors.filter(
      (d) =>
        (d.id === CORE_RULES_DETECTOR_ID || d.replacesCore === CORE_RULES_DETECTOR_ID) &&
        d.egress !== 'external'
    )
    .map((d) => d.id);
}

/**
 * The kinds of identifier in `content` that `supplied` does not contain, as
 * `pii_<type>` labels in order of first appearance.
 */
async function identifierMatches(
  content: string,
  supplied: readonly LlmMessage[],
  ignoredEntityTypes: readonly string[]
): Promise<string[]> {
  const detectorIds = guardDetectorIds();
  if (detectorIds.length === 0) return [];
  const { spans, failures } = await runPrivacyDetectors(content, {
    scopeId: 'output-guard',
    knownValues: [],
    detectorIds,
    ignoredEntityTypes,
    signal: AbortSignal.timeout(OUTPUT_SCAN_TIMEOUT_MS),
  });
  // Flags nothing it could not scan, rather than hold the turn; said here so
  // a quiet guard is not read as a clean reply. Ids only, never the text.
  if (failures.length > 0) {
    logger.warn('output-guard: identifier scan incomplete', {
      failedAdapters: failures.map((f) => f.adapterId),
      reasons: failures.map((f) => f.reason),
    });
  }
  if (spans.length === 0) return [];
  // Each piece on its own: joined, a value could be "found" across the end
  // of one message and the start of the next.
  const pieces = messagePieces(supplied);
  const labels = new Set<string>();
  for (const span of spans) {
    const pattern = writtenAs(content.slice(span.start, span.end));
    if (pattern && pieces.some((p) => pattern.test(p))) continue;
    labels.add(`pii_${span.type.toLowerCase()}`);
  }
  return [...labels];
}

/**
 * Scan an assistant response against per-agent topic boundaries and for
 * identifiers the conversation did not supply.
 *
 * @param content - The assistant response text
 * @param topicBoundaries - Forbidden keywords/phrases from the agent config.
 *   Each entry is matched case-insensitively as a word-boundary substring.
 * @param supplied - What the conversation sent the model: the system prompt,
 *   the user's messages, tool results. An identifier found in it is not
 *   flagged in the reply.
 * @param options.ignoredEntityTypes - Types the admin told the privacy layer
 *   to leave alone; not flagged here either.
 */
export async function scanOutput(
  content: string,
  topicBoundaries: string[],
  supplied: readonly LlmMessage[] = [],
  options: {
    /**
     * Identifier types not to flag: the LLM privacy settings'
     * `privacyIgnoredEntityTypes`, so one admin choice governs both.
     */
    ignoredEntityTypes?: readonly string[];
  } = {}
): Promise<OutputScanResult> {
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

  const builtInMatches = await identifierMatches(
    content,
    supplied,
    options.ignoredEntityTypes ?? []
  );

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
