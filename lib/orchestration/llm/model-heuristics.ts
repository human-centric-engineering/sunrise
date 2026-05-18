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
  DeploymentProfile,
  LatencyLevel,
  RatingLevel,
  TierRole,
  ToolUseLevel,
} from '@/types/orchestration';

import type { Capability } from '@/lib/orchestration/llm/capability-inference';
import type { ParamProfile, ReasoningEffort } from '@/lib/orchestration/llm/types';

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
 * Map a candidate to one of the five capability tier roles. The
 * decision tree mirrors the seed catalogue's classification:
 *
 *   - Embedding capability → `embedding` (only tier for that role)
 *   - Frontier reasoning → `thinking` (expensive, sparse use)
 *   - Cheap + fast → `worker` (parallel tool execution)
 *   - Otherwise → `infrastructure` (default workhorse tier)
 *
 * Deployment locus (`isLocal` / `sovereign`) used to short-circuit this
 * function with `local_sovereign`. That was a structural mistake — a
 * local model can be a high-reasoning thinking-tier model AND
 * sovereign-deployable. The deployment-locus signal now lives in a
 * separate `deploymentProfiles` array (see {@link deriveDeploymentProfiles}).
 */
export function deriveTierRole(args: {
  capability: Capability;
  reasoningDepth: RatingLevel;
  costEfficiency: RatingLevel;
  latency: LatencyLevel;
}): TierRole {
  if (args.capability === 'embedding') return 'embedding';
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
 * Deployment-locus signal — orthogonal to the capability tier. A model
 * marked `isLocal: true` runs on the operator's own infrastructure and
 * carries the `sovereign` profile; everything else defaults to
 * `hosted` (vendor-managed API).
 */
export function deriveDeploymentProfiles(args: { isLocal: boolean }): DeploymentProfile[] {
  return args.isLocal ? ['sovereign'] : ['hosted'];
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

/**
 * Fallback param profile when the DB row's `paramProfile` column is
 * null. Resolution order:
 *
 *   1. Strip known provider prefixes (`openai/`, `azure/`) so an
 *      OpenRouter id like `openai/gpt-5-mini` matches the same patterns
 *      as the bare id. This is the exact failure mode that motivated
 *      promoting param routing into the registry: the prior regex on
 *      `openai-compatible.ts` anchored on `^gpt-5` and silently missed
 *      prefixed ids.
 *   2. Anthropic / Gemini providers always use their own conventions;
 *      they don't go through openai-compatible, but we still return the
 *      matching profile so the admin UI is self-documenting.
 *   3. OpenAI reasoning / gpt-5 family — pattern-matched on the
 *      stripped id. Anchored so a fine-tuned id like `my-gpt-4o-fork`
 *      that happens to contain `gpt-5` as a substring doesn't trigger.
 *   4. Everything else (OpenAI legacy chat models, Llama / Mixtral via
 *      Groq / Together / Fireworks, local Ollama) → `openai-legacy`.
 *
 * Returning `openai-legacy` as the catch-all is the safer default: it
 * matches what the OpenAI-compatible Chat Completions API has accepted
 * for years. A misclassified reasoning model would 400 with a clear
 * error message; a misclassified legacy model would silently work.
 */
export function deriveParamProfile(modelId: string, provider: string): ParamProfile {
  if (provider === 'anthropic') return 'anthropic';
  if (provider === 'gemini') return 'gemini';
  const id = modelId.toLowerCase().replace(/^(openai|azure)\//, '');
  if (/^(o\d+|gpt-5)/.test(id)) return 'openai-reasoning';
  return 'openai-legacy';
}

/**
 * Does this model accept the `reasoningEffort` parameter?
 *
 * Two distinct routes lead to true:
 *   1. **OpenAI reasoning family** — any model resolved to the
 *      `openai-reasoning` param profile accepts `reasoning_effort`
 *      (`minimal | low | medium | high`).
 *   2. **Anthropic extended thinking** — only specific Claude 4 models
 *      accept the `thinking` field. We check this via a prefix match
 *      because the matrix doesn't carry a separate "supports thinking"
 *      column. Patterns covered: `claude-opus-4*`, `claude-sonnet-4-5*`
 *      and later 4.x. Claude Haiku 4.5 is intentionally NOT in the list
 *      — Anthropic doesn't ship extended thinking on Haiku.
 *
 * Anthropic-prefixed Bedrock ids (`anthropic.claude-…`) and OpenRouter
 * ids (`anthropic/claude-…`) are handled by stripping the known
 * prefixes before matching, mirroring `deriveParamProfile`.
 *
 * Anything else → false. The provider class drops the field silently
 * when this returns false, so a misconfigured agent never 400s — the
 * caller intent is still recorded in the trace's `requestParams` so a
 * misuse is visible after the fact.
 */
export function supportsReasoningEffort(
  modelId: string,
  provider: string,
  paramProfile: ParamProfile
): boolean {
  if (paramProfile === 'openai-reasoning') return true;
  if (provider !== 'anthropic' && paramProfile !== 'anthropic') return false;
  const id = modelId
    .toLowerCase()
    .replace(/^(anthropic[./])/, '')
    .replace(/^(.*\/)/, '');
  // Claude Opus 4 and 5+ (any minor) support thinking. The `(?!-?\d)`
  // negative lookahead after the major version prevents `claude-opus-4`
  // from also matching `claude-opus-40` if Anthropic ever ships one with
  // a different family (defensive — they haven't).
  if (/^claude-opus-([4-9]|\d{2,})(?:\b|[-.])/.test(id)) return true;
  // Claude Sonnet 4.5+ supports thinking; Sonnet 4.0–4.4 does not. Match
  // 4.5–4.9 plus any 4.<two-digit>+, then unconditionally any 5+. Both
  // dot and hyphen separators are accepted (`claude-sonnet-4-5` and
  // `claude-sonnet-4.5` both ship in different SDK / API surfaces).
  if (/^claude-sonnet-4[-.](?:[5-9]|\d{2,})(?:\b|[-.])/.test(id)) return true;
  if (/^claude-sonnet-([5-9]|\d{2,})(?:\b|[-.])/.test(id)) return true;
  return false;
}

/**
 * Which `ReasoningEffort` values does this OpenAI-compatible model
 * actually accept?
 *
 * OpenAI's `reasoning_effort` enum has evolved:
 *   - o-series (o1, o1-mini, o3-mini, o4-mini, …) accept
 *     `'low' | 'medium' | 'high'` — they reject `'minimal'` with a 400.
 *   - The gpt-5 family added `'minimal'` to the set.
 *
 * For non-`openai-reasoning` profiles, the field is dropped regardless
 * of value, so this returns the full set — the openai-compatible
 * provider class never reaches it. Anthropic / Gemini have their own
 * shapes and don't consult this function.
 *
 * Used by the openai-compatible provider class to silently drop
 * `'minimal'` when the resolved model is in the o-series, matching the
 * codebase's "drop on unsupported, never 400" pattern for parameter
 * compatibility. The caller's intent is still recorded on the trace's
 * `requestParams.reasoningEffort` so a misconfigured agent is visible
 * after the fact.
 *
 * Anchored at the start of the bare id (after stripping known provider
 * prefixes) so a fine-tune named `my-o3-mini` doesn't inherit the
 * o-series restriction.
 */
export function supportedReasoningEfforts(
  modelId: string,
  provider: string
): ReadonlySet<ReasoningEffort> {
  const id = modelId.toLowerCase().replace(/^(openai|azure)\//, '');
  if (/^o\d+/.test(id) && provider !== 'anthropic' && provider !== 'gemini') {
    // o-series — no 'minimal'.
    return new Set(['low', 'medium', 'high']);
  }
  // Everything else accepts the full bucket set. For models that don't
  // actually consume the field at all (non-reasoning models, Anthropic,
  // Gemini), the openai-compatible / anthropic provider classes drop
  // the field via their own checks — this function only governs the
  // 'minimal' carve-out for OpenAI reasoning models.
  return new Set(['minimal', 'low', 'medium', 'high']);
}

/**
 * Narrow an arbitrary string (typically a DB column read) into the
 * `ReasoningEffort` union, or return `undefined` for any unrecognised
 * value.
 *
 * Why this exists: the column is plain `TEXT` in Postgres (no enum
 * constraint), and the agent form's Zod schema only protects writes
 * that go through the form. Direct SQL writes, backup/import bundles
 * from forks, or future schema migrations could leave garbage values
 * in the column. Without this narrow, the garbage would flow through
 * to `provider.chat()` as a phantom enum member — at which point
 * OpenAI's API would 400 (`Invalid value for reasoning_effort`).
 *
 * Mirror of `narrowParamProfile` in `db-model-adapter.ts`.
 */
export function narrowReasoningEffort(raw: string | null | undefined): ReasoningEffort | undefined {
  if (raw === 'minimal' || raw === 'low' || raw === 'medium' || raw === 'high') return raw;
  return undefined;
}

/**
 * Map a {@link ReasoningEffort} value to Anthropic's `thinking.budget_tokens`.
 *
 * Anthropic's `thinking` parameter is shaped `{ type: 'enabled',
 * budget_tokens: N }` where N is a token budget separate from the
 * `max_tokens` cap. The four `ReasoningEffort` buckets translate as:
 *
 *   - `minimal` — undefined (the `thinking` field is omitted entirely;
 *                 extended thinking is off).
 *   - `low`     — 1024 tokens.
 *   - `medium`  — 4096 tokens.
 *   - `high`    — 16384 tokens.
 *
 * The provider class applies a final clamp against `max_tokens` so the
 * budget can never exceed the visible-output cap; that clamp is the
 * provider's responsibility, not this function's.
 */
export function anthropicThinkingBudget(
  effort: 'minimal' | 'low' | 'medium' | 'high'
): number | undefined {
  switch (effort) {
    case 'minimal':
      return undefined;
    case 'low':
      return 1024;
    case 'medium':
      return 4096;
    case 'high':
      return 16384;
  }
}
