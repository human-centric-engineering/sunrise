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
import { REASONING_EFFORTS } from '@/lib/orchestration/llm/types';
import type { ParamProfile, ReasoningEffort } from '@/lib/orchestration/llm/types';

/**
 * Strip a trailing date stamp from a model id so the name-based tiering
 * heuristics classify the model *family*, not its release snapshot. Vendors
 * version dated snapshots in two shapes:
 *   - hyphenated ISO — `gpt-4o-2024-08-06`, `gpt-5.5-pro-2026-04-23`
 *   - compact        — `claude-3-5-sonnet-20241022`
 * Both trailing forms are removed (with any leading `-`/`_` separator). Only a
 * **trailing** stamp is stripped, and the compact form must start with a
 * plausible year (`19`/`20`), so embedded version numbers (`gpt-4o`,
 * `llama-3.3`) are never touched. Without this, a date suffix can defeat
 * end-anchored name patterns and bury a frontier model in the wrong tier
 * (issue #302, Bug B).
 */
export function stripModelDateStamp(modelId: string): string {
  return modelId.replace(/[-_]?\d{4}-\d{2}-\d{2}$/, '').replace(/[-_]?(?:19|20)\d{6}$/, '');
}

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
  const id = stripModelDateStamp(modelId.toLowerCase());
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
 * Family rules (case-insensitive, on the date-stamp-stripped id):
 *   - `opus`, `o1`, `o3`, `o4`, and the flagship suffixes `pro` / `ultra` /
 *     `max` → very_high (frontier reasoning)
 *   - `sonnet`, `gpt-4`, `gpt-5`, `mistral-large` → high
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
  const id = stripModelDateStamp(modelId.toLowerCase());
  // Frontier reasoning families take precedence — `o1-mini` is still a
  // reasoning model even though `mini` would otherwise downgrade it to
  // medium below. `pro` / `ultra` / `max` are vendors' flagship suffixes
  // (Gemini Pro/Ultra, Qwen-Max, GPT `*-pro`); before this they fell
  // through to `infrastructure` and were mislabelled as a budget tier
  // (issue #302, Bug B). Date stamps are already stripped, so
  // `gpt-5.5-pro-2026-04-23` matches `\bpro\b` here.
  if (
    /\bopus\b/.test(id) ||
    /\bultra\b/.test(id) ||
    /\bmax\b/.test(id) ||
    /\bpro\b/.test(id) ||
    /\bo[134](?:-|$|\b)/.test(id)
  ) {
    return 'very_high';
  }
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
 * Reduce a Claude model id to the bare API form both Claude checks below
 * match against: lower-cased, with any gateway path (`bedrock/`,
 * `anthropic/`) and Bedrock's `anthropic.` prefix — cross-region
 * `us.` / `eu.` / `global.` included — removed.
 */
function normalizeClaudeId(modelId: string): string {
  return modelId
    .toLowerCase()
    .replace(/^.*\//, '')
    .replace(/^(?:[a-z]{2,6}\.)?anthropic\./, '');
}

/**
 * Does this model accept the `reasoningEffort` parameter?
 *
 * Two distinct routes lead to true:
 *   1. **OpenAI reasoning family** — any model resolved to the
 *      `openai-reasoning` param profile accepts `reasoning_effort`
 *      (see `supportedReasoningEfforts` for which values).
 *   2. **Anthropic extended thinking** — only specific Claude models
 *      accept the `thinking` field. We check this via a prefix match
 *      because the matrix doesn't carry a separate "supports thinking"
 *      column. Patterns covered: `claude-opus-4*` and later, Sonnet 4.5
 *      and later, Haiku 4.5 and later, and every Fable and Mythos model.
 *      Haiku 4.5 takes a token budget; the rest of the newer families
 *      take adaptive thinking (`acceptsThinkingBudget` picks the shape).
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
  const id = normalizeClaudeId(modelId);
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
  const version = claudeVersion(id);
  if (!version) return false;
  // Fable and Mythos think on every release (thinking can't be turned off).
  if (version.family === 'fable' || version.family === 'mythos') return true;
  // Haiku 4.5 takes a thinking budget; Haiku 5+ takes adaptive thinking.
  if (version.family === 'haiku') return atLeast(version, 4, 5);
  return false;
}

/** A Claude model id split into family and version, e.g. Opus 4.6. */
interface ClaudeVersion {
  family: 'opus' | 'sonnet' | 'haiku' | 'fable' | 'mythos';
  major: number;
  minor: number;
}

/**
 * Parse a family-first Claude id (`claude-opus-4-6`, `claude-fable-5-1`)
 * already through `normalizeClaudeId`. A missing minor, or a date stamp in
 * its place (`claude-opus-4-20250514`), is `.0`. The older version-first
 * names (`claude-3-5-sonnet`) and unknown families return `undefined`.
 */
function claudeVersion(id: string): ClaudeVersion | undefined {
  const match =
    /^claude-(opus|sonnet|haiku|fable|mythos)-(\d{1,2})(?:[-.](\d{1,2})(?!\d))?(?:$|[-.@:[_])/.exec(
      id
    );
  if (!match) return undefined;
  return {
    family: match[1] as ClaudeVersion['family'],
    major: Number(match[2]),
    minor: match[3] === undefined ? 0 : Number(match[3]),
  };
}

function atLeast(version: ClaudeVersion, major: number, minor: number): boolean {
  return version.major > major || (version.major === major && version.minor >= minor);
}

/**
 * Does this Claude model take native structured output
 * (`output_config.format: { type: 'json_schema', schema }`)?
 *
 * Anthropic documents it on Fable and Mythos, Opus 4.1, 4.5, 4.8 and 5+,
 * Sonnet 5+, Haiku 4.5 and Haiku 5+. Opus 4.0 / 4.6 / 4.7 and Sonnet 4.x
 * are not on that list, so they keep the forced extraction tool. Native
 * output needs no tool, so it can't clash with thinking or with the newer
 * models' refusal of a forced `tool_choice`.
 *
 * Ids the parser doesn't recognise return false and keep the extraction
 * tool, which every Claude model accepts.
 */
export function acceptsNativeStructuredOutput(modelId: string): boolean {
  const version = claudeVersion(normalizeClaudeId(modelId));
  if (!version) return false;
  switch (version.family) {
    case 'fable':
    case 'mythos':
      return true;
    case 'opus':
      if (version.major !== 4) return version.major > 4;
      return version.minor === 1 || version.minor === 5 || version.minor >= 8;
    case 'sonnet':
      return version.major >= 5;
    case 'haiku':
      return atLeast(version, 4, 5);
  }
}

/**
 * Does this Claude model take Anthropic's server-side web search tool?
 *
 * Anthropic offers it on Claude 3.5 Haiku, 3.5 Sonnet and 3.7 Sonnet, and on
 * every family-first model since (Opus / Sonnet / Haiku 4+, Fable, Mythos).
 * The Claude 3.0 models and ids the parser doesn't recognise return false,
 * so the provider drops the tool rather than sending one that 400s.
 */
export function acceptsWebSearch(modelId: string): boolean {
  const id = normalizeClaudeId(modelId);
  if (/^claude-3-[57]-(?:sonnet|haiku)(?:\b|[-.@:]|$)/.test(id)) return true;
  return claudeVersion(id) !== undefined;
}

/**
 * Does this Claude model take Anthropic's code execution tool?
 *
 * Anthropic lists Opus, Sonnet and Haiku from 4.5 on, and Fable and Mythos
 * (its code execution doc, 2026-10-27). The Claude 3 models, Opus 4.0 / 4.1,
 * Sonnet 4.0 and ids the parser doesn't recognise return false, so the
 * provider drops the tool rather than sending one that 400s.
 */
export function acceptsCodeExecution(modelId: string): boolean {
  const version = claudeVersion(normalizeClaudeId(modelId));
  if (!version) return false;
  if (version.family === 'fable' || version.family === 'mythos') return true;
  return atLeast(version, 4, 5);
}

/**
 * Does this Claude model refuse a forced `tool_choice` (`any` or a named
 * tool) outright, with a 400?
 *
 * Opus 5.5, Sonnet 5.5, Fable 5.1 and Mythos 5.1 do, whatever the thinking
 * setting; later releases of those families are assumed to as well. Every
 * Claude model also refuses one alongside an explicit `thinking` field,
 * which the provider handles separately.
 */
export function refusesForcedToolChoice(modelId: string): boolean {
  const version = claudeVersion(normalizeClaudeId(modelId));
  if (!version) return false;
  switch (version.family) {
    case 'opus':
    case 'sonnet':
      return atLeast(version, 5, 5);
    case 'fable':
    case 'mythos':
      return atLeast(version, 5, 1);
    case 'haiku':
      return false;
  }
}

/**
 * Does this Claude model accept a sampling `temperature`?
 *
 * Anthropic removed the sampling parameters (`temperature`, `top_p`,
 * `top_k`) from its newer models: Opus 4.7+, Sonnet 5+, Haiku 5+, Fable
 * and Mythos all 400 on a non-default value. Only the older families
 * still honour one: Claude 2 / 3.x, Haiku 4.x, and Opus / Sonnet 4.0–4.6.
 *
 * This is an allow-list of those older families, so a model this
 * function doesn't recognise has its temperature left out rather than
 * sent. A dropped temperature loses a setting; a sent one fails the
 * whole call — and every Claude model released since 4.6 refuses it.
 * The caller's intent is still recorded on the trace's
 * `requestParams.temperature`.
 *
 * Ids go through `normalizeClaudeId`, so Bedrock, cross-region and
 * OpenRouter forms classify the same as the bare API id. The minor version must be one or two digits,
 * so a date stamp (`claude-sonnet-4-20250514`) reads as Sonnet 4.0.
 */
export function acceptsSamplingTemperature(modelId: string): boolean {
  const id = normalizeClaudeId(modelId);
  // Claude 2 / 3.x — every family accepts it (`claude-3-5-sonnet`,
  // `claude-3-haiku`, `claude-instant-1.2`, `claude-2.1`).
  if (/^claude-(?:instant|[23])(?:\b|[-.])/.test(id)) return true;
  return isClaudeFourUpToSixOrOlderHaiku(id);
}

/**
 * Haiku 4.x and earlier under the family-first naming, or Opus / Sonnet
 * 4.0–4.6 — the last families before Anthropic removed both sampling
 * parameters and thinking budgets. Takes an id already through
 * `normalizeClaudeId`. A missing minor, or a date stamp in its place,
 * is 4.0.
 */
function isClaudeFourUpToSixOrOlderHaiku(id: string): boolean {
  if (/^claude-haiku-[1-4](?:\b|[-.])/.test(id)) return true;
  const four = /^claude-(?:opus|sonnet)-4(?:[-.](\d{1,2})(?!\d))?(?:\b|[-.]|$)/.exec(id);
  if (four) {
    const minor = four[1] === undefined ? 0 : Number(four[1]);
    return minor <= 6;
  }
  return false;
}

/**
 * Does this Claude model take a fixed thinking budget
 * (`thinking: { type: 'enabled', budget_tokens: N }`)?
 *
 * Anthropic removed `budget_tokens` from its newer models: Opus 4.7+,
 * Sonnet 5+, Haiku 5+ and Fable 400 on it, and take adaptive thinking
 * (`thinking: { type: 'adaptive' }` with depth set by
 * `output_config.effort`) instead. Only the older families still take a
 * budget: Haiku 4.x and Opus / Sonnet 4.0–4.6 (deprecated on 4.6, still
 * accepted).
 *
 * An allow-list of those older families, as with
 * `acceptsSamplingTemperature`, so a model this function doesn't
 * recognise is sent adaptive thinking — every Claude release since 4.6
 * has taken it. Ids go through `normalizeClaudeId`; a date stamp in the
 * minor's place reads as 4.0.
 */
export function acceptsThinkingBudget(modelId: string): boolean {
  return isClaudeFourUpToSixOrOlderHaiku(normalizeClaudeId(modelId));
}

/**
 * Which `ReasoningEffort` values does this OpenAI-compatible model
 * actually accept?
 *
 * OpenAI's `reasoning_effort` enum has evolved:
 *   - o-series (o1, o1-mini, o3-mini, o4-mini, …) accept
 *     `'low' | 'medium' | 'high'` — they reject `'minimal'` with a 400.
 *   - The gpt-5 family added `'minimal'` to the set.
 *   - `'xhigh'` / `'max'` are never in the set: OpenAI accepts them on some
 *     models only, without a per-id list. The provider clamps them to
 *     `'high'` (`openAiReasoningEffort`) before consulting this.
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
 * The `reasoning_effort` an OpenAI-compatible reasoning model is sent for
 * this bucket: `xhigh` and `max` become `high` (see
 * {@link supportedReasoningEfforts}); the rest go as they are.
 */
export function openAiReasoningEffort(
  effort: ReasoningEffort
): 'minimal' | 'low' | 'medium' | 'high' {
  return effort === 'xhigh' || effort === 'max' ? 'high' : effort;
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
  return REASONING_EFFORTS.find((effort) => effort === raw);
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
 *   - `xhigh`   — 32768 tokens.
 *   - `max`     — 65536 tokens.
 *
 * The provider class applies a final clamp against `max_tokens` so the
 * budget can never exceed the visible-output cap; that clamp is the
 * provider's responsibility, not this function's.
 */
export function anthropicThinkingBudget(effort: ReasoningEffort): number | undefined {
  switch (effort) {
    case 'minimal':
      return undefined;
    case 'low':
      return 1024;
    case 'medium':
      return 4096;
    case 'high':
      return 16384;
    case 'xhigh':
      return 32768;
    case 'max':
      return 65536;
  }
}

/**
 * Map a {@link ReasoningEffort} value to Anthropic's `output_config.effort`
 * for models on adaptive thinking (see `acceptsThinkingBudget`).
 *
 *   - `minimal` — `low`. Several of these models can't turn thinking off
 *                 (Opus 5.5 and Sonnet 5.5 400 on `{ type: 'disabled' }`),
 *                 so the lowest effort is the nearest they get. The
 *                 provider sends it without a `thinking` field.
 *   - `low` / `medium` / `high` / `xhigh` / `max` — the same name. Every
 *                 adaptive-thinking model (Opus 4.7+, Sonnet 5+, Haiku 5+,
 *                 Fable, Mythos) takes all five; Opus 4.6 / Sonnet 4.6,
 *                 which lack `xhigh`, are on a thinking budget instead.
 */
export function anthropicAdaptiveEffort(
  effort: ReasoningEffort
): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
  return effort === 'minimal' ? 'low' : effort;
}

/**
 * Does this OpenAI model take the Responses API's `web_search` tool?
 *
 * Measured against the live API (2026-10-27): GPT-5 and its numbered releases
 * (nano included), gpt-4.1 and gpt-4.1-mini, gpt-4o and gpt-4o-mini, and per
 * OpenAI's docs o3 and o4-mini. gpt-4.1-nano is a 400, as are o3-mini and the
 * older chat models. The search, audio, realtime, speech and transcription
 * variants of these families are not chat models on the Responses API
 * (gpt-4o-mini-search-preview and gpt-5-search-api are a 400, measured), so
 * they return false. A model it doesn't recognise returns false, so the
 * request stays on Chat Completions without search rather than 400ing.
 *
 * GPT-5 also refuses the tool at `minimal` reasoning effort; the routing in
 * `openai-responses.ts` checks that, since it depends on the request.
 */
export function acceptsOpenAiWebSearch(modelId: string): boolean {
  const id = bareOpenAiId(modelId);
  if (/^gpt-4\.1-nano(?:$|-)/.test(id)) return false;
  if (/-(?:search|audio|realtime|tts|transcribe)(?:$|-)/.test(id)) return false;
  return /^(?:gpt-5(?:$|[-.])|gpt-4\.1(?:$|-)|gpt-4o(?:$|-(?:mini(?:$|-)|\d{4}-))|o3(?:$|-\d{4}-)|o4-mini(?:$|-))/.test(
    id
  );
}

/**
 * Does this OpenAI model take the Responses API's `code_interpreter` tool?
 *
 * The models that take web search ({@link acceptsOpenAiWebSearch}) do:
 * measured on gpt-5-mini, gpt-4.1, gpt-4.1-mini, gpt-4o and gpt-4o-mini
 * (2026-10-27), and OpenAI documents it on o3 and o4-mini. Like web search,
 * it is a 400 at `minimal` reasoning effort, which the routing checks.
 */
export function acceptsOpenAiCodeInterpreter(modelId: string): boolean {
  return acceptsOpenAiWebSearch(modelId);
}

/**
 * Does this OpenAI model take `filters` (allowed / blocked sites) on its
 * `web_search` tool? gpt-4o-mini and gpt-4.1-mini search but refuse filters
 * with a 400 (measured 2026-10-27); every other model
 * {@link acceptsOpenAiWebSearch} accepts takes them.
 */
export function acceptsOpenAiWebSearchFilters(modelId: string): boolean {
  if (!acceptsOpenAiWebSearch(modelId)) return false;
  return !/^gpt-4(?:o|\.1)-mini(?:$|-)/.test(bareOpenAiId(modelId));
}

/**
 * Does this model take OpenAI's `verbosity`? The GPT-5 family does; the
 * o-series and older chat models refuse it. Anchored at the start of the
 * bare id, so `openai/gpt-5-mini` and dated snapshots match and a fine-tune
 * named `my-gpt-5` does not.
 */
export function acceptsVerbosity(modelId: string): boolean {
  return /^gpt-5(?:$|[-.])/.test(bareOpenAiId(modelId));
}

/**
 * Does OpenAI offer the `flex` service tier on this model? Its list is the
 * GPT-5 models themselves (base, mini, nano, numbered releases), o3 and
 * o4-mini; a flex request to any other model — gpt-4o, o3-mini, or a GPT-5
 * variant such as `-chat-latest`, `-pro` or `-codex` — is a 400. So an
 * allow-list, and a model it doesn't recognise is sent no tier.
 */
export function acceptsFlexTier(modelId: string): boolean {
  const id = bareOpenAiId(modelId);
  const dated = '(?:-\\d{4}-\\d{2}-\\d{2})?$';
  return (
    new RegExp(`^gpt-5(?:\\.\\d+)?(?:-mini|-nano)?${dated}`).test(id) ||
    new RegExp(`^(?:o3|o4-mini)${dated}`).test(id)
  );
}

/**
 * Does this OpenAI reasoning model take `parallel_tool_calls`? The GPT-5
 * family does; the o-series refuses it with a 400. Non-reasoning chat models
 * always take it and don't ask this.
 */
export function reasoningModelAcceptsParallelToolCalls(modelId: string): boolean {
  return /^gpt-5(?:$|[-.])/.test(bareOpenAiId(modelId));
}

/** An OpenAI model id without an `openai/` or `azure/` prefix, lower-cased. */
function bareOpenAiId(modelId: string): string {
  return modelId.toLowerCase().replace(/^(openai|azure)\//, '');
}
