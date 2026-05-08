/**
 * Model Heuristics
 *
 * Pure functions that map raw signals (model id, capability, costs,
 * context length, supportsTools) to the matrix's six rating-style
 * enum fields. Used by the discovery endpoint to pre-fill review-step
 * defaults so the operator picks from constrained controls instead of
 * guessing values for `tierRole`, `latency`, etc.
 *
 * No I/O, no network, no Prisma — just classification rules. That
 * lets the discovery route call these synchronously per candidate
 * without a perf concern, and keeps the test surface trivial
 * (table-driven).
 *
 * The thresholds here are intentionally conservative: when uncertain,
 * pick `medium` for ratings so the operator sees neutral defaults
 * rather than aggressive ones they'd have to walk back.
 */

import type {
  ContextLengthLevel,
  LatencyLevel,
  RatingLevel,
  TierRole,
  ToolUseLevel,
} from '@/types/orchestration';

import type { Capability } from '@/lib/orchestration/llm/capability-inference';

/**
 * Map input cost ($/M tokens) to the cost-efficiency rating used in
 * the matrix. Lower input cost is more efficient.
 *
 * Thresholds chosen from the seed-009 catalogue distribution:
 *   - GPT-4o-mini ($0.15) → very_high
 *   - Haiku 4.5 ($1.00), Sonnet 4.6 ($3.00) → high / medium boundary
 *   - GPT-4o ($2.50) → high
 *   - Opus 4.6 ($15.00) → none (frontier; cost is the trade-off)
 *
 * `null` (cost unknown) → medium so the row isn't auto-flagged as
 * "best in class" or "uneconomic" without evidence.
 */
export function deriveCostEfficiency(inputCostPerMillion: number | null): RatingLevel {
  if (inputCostPerMillion === null || inputCostPerMillion === undefined) return 'medium';
  if (inputCostPerMillion <= 0.5) return 'very_high';
  if (inputCostPerMillion <= 2) return 'high';
  if (inputCostPerMillion <= 10) return 'medium';
  return 'none';
}

/**
 * Map context window size (tokens) to the matrix's context-length
 * rating. Boundaries match real-world thresholds:
 *   - 1M tokens → very_high (Gemini Pro, Claude 4.x)
 *   - 128K → high (modern GPT-4 / GPT-5 family, Sonnet)
 *   - 32K → medium (older / cheaper variants)
 *   - else / null → n_a
 */
export function deriveContextLength(maxContext: number | null): ContextLengthLevel {
  if (maxContext === null || maxContext === undefined || maxContext <= 0) return 'n_a';
  if (maxContext >= 1_000_000) return 'very_high';
  if (maxContext >= 128_000) return 'high';
  if (maxContext >= 32_000) return 'medium';
  return 'n_a';
}

/**
 * Latency inferred from model id naming conventions. Vendors signal
 * latency tier through suffixes — `-mini`, `-nano`, `-flash`,
 * `-haiku`, `-turbo` — much more reliably than they signal it
 * through pricing. `flash-lite` and `nano` are the smallest +
 * fastest tiers, so they get `very_fast`.
 *
 * Default is `medium` — operator can still bump it in the review
 * step.
 */
export function deriveLatency(modelId: string): LatencyLevel {
  const id = modelId.toLowerCase();
  // Smallest / fastest variants → very_fast
  if (/\bnano\b/.test(id) || /flash-lite\b/.test(id)) return 'very_fast';
  // Common "fast" suffixes
  if (/(?:-|^)(?:mini|flash|haiku|turbo)\b/.test(id)) return 'fast';
  return 'medium';
}

/**
 * Reasoning depth inferred from model family. Non-chat capabilities
 * get `none` since reasoning depth is a chat-only signal.
 *
 * Family rules (case-insensitive substring on the id):
 *   - `opus`, `o1`, `o3`, `o4` → very_high (frontier reasoning)
 *   - `sonnet`, `gpt-4`, `gpt-5`, `gemini-pro`, `gemini-1.5-pro`,
 *     `mistral-large` → high
 *   - `haiku`, `mini`, `flash`, `nano` → medium
 *   - else → medium (neutral default)
 */
export function deriveReasoningDepth(modelId: string, capability: Capability): RatingLevel {
  if (
    capability === 'embedding' ||
    capability === 'image' ||
    capability === 'audio' ||
    capability === 'moderation'
  ) {
    return 'none';
  }
  const id = modelId.toLowerCase();
  // Frontier reasoning families take precedence — `o1-mini` is still
  // a reasoning model even though `mini` would otherwise downgrade
  // it to medium below.
  if (/\bopus\b/.test(id) || /\bo[134](?:-|$|\b)/.test(id)) return 'very_high';
  // Cheap / fast variants downgrade to medium even within the gpt-4
  // family — `gpt-4o-mini` shouldn't claim the same reasoning depth
  // as `gpt-4o` proper. Word boundaries on both sides so `gemini`
  // (which contains the substring `mini`) doesn't accidentally
  // downgrade itself.
  if (/\b(?:haiku|mini|flash|nano)\b/.test(id)) return 'medium';
  if (
    /\bsonnet\b/.test(id) ||
    /gpt-4/.test(id) ||
    /gpt-5/.test(id) ||
    /\bgemini-pro\b/.test(id) ||
    /\bgemini-1\.5-pro\b/.test(id) ||
    /\bmistral-large\b/.test(id)
  ) {
    return 'high';
  }
  return 'medium';
}

/**
 * Map a candidate to one of the six tier roles. The decision tree
 * mirrors the seed catalogue's classification:
 *
 *   - Embedding capability → `embedding` (only tier for that role)
 *   - Local model → `local_sovereign` (regardless of other dims)
 *   - Frontier reasoning → `thinking` (expensive, sparse use)
 *   - Cheap + fast → `worker` (parallel tool execution)
 *   - Otherwise → `infrastructure` (default workhorse tier)
 */
export function deriveTierRole(args: {
  capability: Capability;
  reasoningDepth: RatingLevel;
  costEfficiency: RatingLevel;
  latency: LatencyLevel;
  isLocal: boolean;
}): TierRole {
  if (args.capability === 'embedding') return 'embedding';
  if (args.isLocal) return 'local_sovereign';
  if (args.reasoningDepth === 'very_high') return 'thinking';
  if (
    (args.costEfficiency === 'very_high' || args.costEfficiency === 'high') &&
    (args.latency === 'fast' || args.latency === 'very_fast')
  ) {
    return 'worker';
  }
  return 'infrastructure';
}

/**
 * Tool-use rating. The clearest signal is OpenRouter's
 * `supported_parameters` array — when it lists `'tools'`, the model
 * has first-class tool calling. Embedding / image / audio models
 * have no tool-call surface.
 */
export function deriveToolUse(args: {
  supportsTools: boolean;
  capability: Capability;
}): ToolUseLevel {
  if (
    args.capability === 'embedding' ||
    args.capability === 'image' ||
    args.capability === 'audio' ||
    args.capability === 'moderation'
  ) {
    return 'none';
  }
  if (args.supportsTools) return 'strong';
  return 'moderate';
}

/**
 * Short canned phrase per (tier, capability) combination — the
 * matrix's `bestRole` field. Operator can edit in the review step,
 * but a sensible default is far better than an empty string for
 * models added in bulk.
 */
export function deriveBestRole(tier: TierRole, capability: Capability): string {
  if (capability === 'embedding') return 'Embedding for KB search';
  if (capability === 'image') return 'Image generation';
  if (capability === 'audio') return 'Audio transcription / synthesis';
  if (capability === 'moderation') return 'Content moderation';
  switch (tier) {
    case 'thinking':
      return 'Planner / orchestrator';
    case 'worker':
      return 'Quick worker for tool calls';
    case 'infrastructure':
      return 'General-purpose workhorse';
    case 'control_plane':
      return 'Routing / fallback / compliance';
    case 'local_sovereign':
      return 'On-prem / private inference';
    case 'embedding':
      return 'Embedding for KB search';
  }
}

/**
 * Slug derivation matches the existing `provider-model-form.tsx`
 * `toSlug()` rule (lowercase, alphanumerics + single hyphens, no
 * leading/trailing hyphens). Re-exported here so the bulk endpoint
 * and discovery suggestions stay aligned.
 */
export function deriveMatrixSlug(providerSlug: string, modelId: string): string {
  return [providerSlug, modelId]
    .filter(Boolean)
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}
