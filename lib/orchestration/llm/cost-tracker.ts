/**
 * Cost Tracker
 *
 * Computes the USD cost of an LLM operation using the model registry,
 * writes granular cost rows to `AiCostLog`, aggregates spend by agent,
 * and enforces the monthly budgets: the agent's, its org's, and the global
 * cap.
 *
 * Local models always cost \$0 — we still record their token counts for
 * benchmarking, but `isLocal: true` rows contribute nothing to spend.
 *
 * `logCost` is intentionally forgiving: a Prisma write failure is
 * logged and surfaced to the caller as `null` rather than thrown,
 * because a chat response should never be lost due to an accounting
 * failure. Callers that need strict behaviour can check the return
 * value.
 *
 * Platform-agnostic: no Next.js imports.
 */

import type { AiCostLog, Prisma } from '@/types/prisma';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { keepRunningAfterResponse } from '@/lib/api/after-response';
import { getAvailableModels, getModel } from '@/lib/orchestration/llm/model-registry';
import { touchAgentLastActive } from '@/lib/orchestration/agents/touch-last-active';
import {
  globalCapStateOrSkip,
  noteSpend,
  orgCapStateOrSkip,
  utcMonthStart,
} from '@/lib/orchestration/llm/spend-caps';
import type { AgentCostSummary, CostOperation, LocalSavingsResult } from '@/types/orchestration';
import type { ModelInfo } from '@/lib/orchestration/llm/types';

/** Computed cost breakdown for a single operation. */
export interface ComputedCost {
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  /** True when the model was resolved from the local tier. */
  isLocal: boolean;
  /**
   * Set when no rate was available — the model is not in the registry, or
   * its only source is a matrix row with no cost. The zeros above then mean
   * "not priced", not "free"; `logCost` records that on the row.
   */
  unpriced?: true;
}

/**
 * Whisper pricing — USD per minute of input audio.
 *
 * Hardcoded for v1 because OpenAI Whisper is the only audio model the
 * platform currently routes to; per-minute pricing makes a per-token
 * column on `AiProviderModel` the wrong shape. When a second audio
 * provider lands (Deepgram, ElevenLabs, etc.), promote this to a
 * `pricePerMinuteUsd` column on `AiProviderModel` and look it up by
 * model id like the chat path does.
 */
export const WHISPER_USD_PER_MINUTE = 0.006;

/**
 * Flat per-image attachment cost. Picked at OpenAI's low-detail tile
 * price (~$0.001275 / image) — chosen because GPT-4o low-detail is the
 * cheapest vision-capable endpoint among the seeded models and the
 * point of this row is to track platform-level overhead, not the
 * underlying token spend (which rolls up under the chat row).
 *
 * v2: promote to a per-row `pricePerImageUsd` column on
 * `AiProviderModel` and resolve per model id when per-tile precision
 * becomes worth the complexity.
 */
export const IMAGE_USD_PER_IMAGE = 0.001275;

/**
 * Flat per-PDF attachment cost. Anthropic charges ~$0.0048 per page
 * for native PDF processing; we use a conservative single-page average
 * for v1 (most worked examples — boiler plates, planning notices —
 * are one to three pages).
 */
export const PDF_USD_PER_PDF = 0.005;

/**
 * Embedding model rates in USD per million input tokens.
 *
 * Hardcoded for v1 because the runtime `getModel(...)` lookup is sourced
 * from OpenRouter's chat-completion catalogue, which doesn't carry
 * embedding models. Mirrors the seed values in
 * `prisma/seeds/009-provider-models.ts` so admins running the seeded
 * registry see the same numbers in cost reports.
 *
 * A model missing from this map is priced from the model registry, which
 * carries the Model Matrix's `costPerMillionTokens` (Google, Mistral and
 * Cohere embeddings are priced there, not here). A model neither prices is
 * recorded at $0 for volume tracking and marked unpriced. Local providers (Ollama nomic-embed-text,
 * etc.) are intentionally absent: the `provider.isLocal` flag flips them
 * to `isLocal: true` in `logCost` so they always cost $0.
 */
export const EMBEDDING_USD_PER_MILLION_TOKENS: Record<string, number> = {
  'text-embedding-3-small': 0.02,
  'text-embedding-3-large': 0.13,
  'text-embedding-ada-002': 0.1,
  'voyage-3': 0.06,
  'voyage-3-lite': 0.02,
  'voyage-large-2': 0.12,
  'voyage-code-2': 0.12,
};

/**
 * Compute the USD cost of an embedding call from the model id and the
 * input-token count reported by the provider's `usage.prompt_tokens`.
 * The rate comes from `EMBEDDING_USD_PER_MILLION_TOKENS` first — the exact
 * list price for the models it names — then from the registry, whose
 * single matrix rate is exactly an embedding's one rate. A model neither
 * prices returns zeroed costs with `unpriced: true`, so it still produces
 * an `AiCostLog` row for volume tracking, marked as unknown, not free.
 *
 * Returns `isLocal: false` unless the registry lists the model at the local
 * tier, as `calculateCost` does — "rate unknown" is NOT "local". The
 * caller is responsible for setting `isLocal` from `provider.isLocal`
 * (true Ollama-style local models) via `logCost`'s OR. An earlier
 * version inferred local-ness from a zero rate, which incorrectly
 * tagged unmapped cloud embeddings (a brand-new OpenAI/Voyage model
 * the rate table hasn't caught up with) as local and polluted the
 * `calculateLocalSavings` report.
 */
export function calculateEmbeddingCost(modelId: string, inputTokens: number): ComputedCost {
  if (!Number.isFinite(inputTokens) || inputTokens <= 0) {
    return { inputCostUsd: 0, outputCostUsd: 0, totalCostUsd: 0, isLocal: false };
  }
  let ratePerMillion = EMBEDDING_USD_PER_MILLION_TOKENS[modelId];
  if (ratePerMillion === undefined) {
    const model = getModel(modelId);
    if (model?.tier === 'local') {
      return { inputCostUsd: 0, outputCostUsd: 0, totalCostUsd: 0, isLocal: true };
    }
    if (!model || model.pricingUnknown) {
      // Debug, not warn: this runs on every knowledge search, twice (the
      // embedder and `logCost` both cost the call), and the row it produces
      // already says `pricing: 'unknown'`.
      logger.debug('Embedding cost: model has no price, treating as zero cost', {
        model: modelId,
      });
      return { inputCostUsd: 0, outputCostUsd: 0, totalCostUsd: 0, isLocal: false, unpriced: true };
    }
    ratePerMillion = model.inputCostPerMillion;
  }
  const totalCostUsd = (inputTokens / 1_000_000) * ratePerMillion;
  return {
    inputCostUsd: totalCostUsd,
    outputCostUsd: 0,
    totalCostUsd,
    isLocal: false,
  };
}

/** Parameters for `logCost`. */
export interface LogCostParams {
  agentId?: string;
  conversationId?: string;
  workflowExecutionId?: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  operation: CostOperation;
  /**
   * Audio duration in milliseconds — required when `operation` is
   * `'transcription'`, ignored otherwise. Whisper is billed per minute
   * of input audio, not per token, so the per-row cost derives from
   * this field rather than the token counts.
   */
  durationMs?: number;
  /**
   * Image attachment count — required when `operation` is `'vision'`
   * and the request carried any `image/*` attachments. Cost rolls up
   * as `imageCount × IMAGE_USD_PER_IMAGE`. Stamped into the metadata
   * column so analytics can split image vs PDF contribution.
   */
  imageCount?: number;
  /**
   * PDF / document attachment count — required when `operation` is
   * `'vision'` and the request carried any `application/pdf`
   * attachments. Cost rolls up as `pdfCount × PDF_USD_PER_PDF`.
   * Stamped into the metadata column alongside `imageCount`.
   */
  pdfCount?: number;
  /** Explicit override; otherwise inferred from the model registry tier. */
  isLocal?: boolean;
  metadata?: Record<string, unknown>;
  /**
   * OTEL trace correlation. Set when a non-default tracer is registered and
   * the call site has an active span. Empty strings (returned by the no-op
   * tracer) are normalised to `undefined` so historical analytics queries
   * filtering on `WHERE traceId IS NULL` keep working.
   */
  traceId?: string;
  spanId?: string;
  /**
   * Who incurred this cost, when a person did. Accepts `null` so a caller can
   * forward a context that is legitimately user-less (`ctx.userId`,
   * `context.userId`) without branching at every call site — a scheduled
   * workflow run and a user-triggered one then use the identical line, and
   * the null falls out of the context rather than being decided here.
   *
   * Null/empty is normalised away before the write, so a row either carries a
   * real user or carries none. See the column's own note in
   * `orchestration-providers.prisma` for which paths are legitimately
   * user-less.
   */
  userId?: string | null;
}

/**
 * Compute the USD cost of a transcription operation given an audio
 * duration. Returns zeroed costs for non-positive durations so a
 * provider returning `duration: 0` (no usage info) records as $0
 * rather than NaN.
 */
export function calculateTranscriptionCost(durationMs: number): ComputedCost {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return { inputCostUsd: 0, outputCostUsd: 0, totalCostUsd: 0, isLocal: false };
  }
  const totalCostUsd = (durationMs / 60_000) * WHISPER_USD_PER_MINUTE;
  return {
    inputCostUsd: totalCostUsd,
    outputCostUsd: 0,
    totalCostUsd,
    isLocal: false,
  };
}

/**
 * Compute the USD cost of an attachment-bearing chat turn given image
 * and PDF counts. Flat per-attachment pricing for v1. Negative or
 * non-finite counts collapse to zero so a buggy caller can't produce
 * NaN cost rows.
 */
export function calculateAttachmentCost(imageCount: number, pdfCount: number): ComputedCost {
  const safeImages = Number.isFinite(imageCount) && imageCount > 0 ? Math.floor(imageCount) : 0;
  const safePdfs = Number.isFinite(pdfCount) && pdfCount > 0 ? Math.floor(pdfCount) : 0;
  const totalCostUsd = safeImages * IMAGE_USD_PER_IMAGE + safePdfs * PDF_USD_PER_PDF;
  return {
    inputCostUsd: totalCostUsd,
    outputCostUsd: 0,
    totalCostUsd,
    isLocal: false,
  };
}

/** Budget snapshot returned by `checkBudget`. */
export interface BudgetStatus {
  withinBudget: boolean;
  spent: number;
  limit: number | null;
  remaining: number | null;
  /**
   * Set when the singleton `AiOrchestrationSettings.globalMonthlyBudgetUsd`
   * has been met or exceeded by the combined spend of *all* agents this
   * calendar month. Distinguishes a global cap breach from a per-agent one
   * so the chat handler can emit a more specific error code.
   */
  globalCapExceeded?: boolean;
  /**
   * Set when the agent's org has a cap of its own (`Org.settings.quotas
   * .monthlyBudgetUsd`, §110 t-788): the cap and the org's month-to-date
   * spend. Absent when the org has none, which is the default.
   */
  org?: { limit: number; spent: number };
  /** Set when the org's month-to-date spend has met or passed its cap. */
  orgCapExceeded?: boolean;
}

// The org and global caps live in `spend-caps.ts`, which the provider manager's
// call-time gate also reads. Re-exported for the surfaces that show them.
export {
  getGlobalCapState,
  getMonthToDateGlobalSpend,
  type GlobalCapState,
} from '@/lib/orchestration/llm/spend-caps';

/**
 * Compute the USD cost of an operation for the given model and token
 * counts. Returns zeroed costs for local models, and zeroed costs marked
 * `unpriced` for a model with no rate (not in the registry, or registered
 * from a matrix row with a null cost) — logging a warning so it can be added.
 */
export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): ComputedCost {
  if (
    !Number.isFinite(inputTokens) ||
    inputTokens < 0 ||
    !Number.isFinite(outputTokens) ||
    outputTokens < 0
  ) {
    logger.warn('Invalid token counts, treating as zero cost', {
      modelId,
      inputTokens,
      outputTokens,
    });
    return { inputCostUsd: 0, outputCostUsd: 0, totalCostUsd: 0, isLocal: false };
  }

  const model = getModel(modelId);
  if (!model) {
    logger.warn('Cost calculation: unknown model, treating as zero cost', { model: modelId });
    // "Rate unknown" is NOT "local". An earlier version returned
    // `isLocal: true` here, which silently flagged every unmapped cloud
    // model (gpt-5, new OpenRouter ids, anything missing from the
    // registry) as local and polluted the `calculateLocalSavings` report
    // with phantom savings. Mirrors the same fix already applied to
    // `calculateEmbeddingCost`. Callers running real local providers
    // (Ollama et al.) get the flag set explicitly via `logCost`'s
    // `params.isLocal ?? cost.isLocal` OR.
    return { inputCostUsd: 0, outputCostUsd: 0, totalCostUsd: 0, isLocal: false, unpriced: true };
  }

  if (model.tier === 'local') {
    return { inputCostUsd: 0, outputCostUsd: 0, totalCostUsd: 0, isLocal: true };
  }

  if (model.pricingUnknown) {
    logger.warn('Cost calculation: model has no price, treating as zero cost', {
      model: modelId,
    });
    return { inputCostUsd: 0, outputCostUsd: 0, totalCostUsd: 0, isLocal: false, unpriced: true };
  }

  const inputCostUsd = (inputTokens / 1_000_000) * model.inputCostPerMillion;
  const outputCostUsd = (outputTokens / 1_000_000) * model.outputCostPerMillion;
  return {
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd,
    isLocal: false,
  };
}

/**
 * Persist an `AiCostLog` row. Returns the created row on success, or
 * `null` if the Prisma write failed (error is logged, not thrown, so
 * the caller can continue serving the user-facing response).
 *
 * Kept alive past the response (t-903): most callers write `void logCost(...)`,
 * and a cost row frozen part-way on a serverless host is spend the budget caps
 * and the costs dashboard never see. The write registers itself with
 * `keepRunningAfterResponse`.
 */
export function logCost(params: LogCostParams): Promise<AiCostLog | null> {
  const write = writeCostLog(params);
  keepRunningAfterResponse(write, 'Cost log write', { operation: params.operation });
  return write;
}

async function writeCostLog(params: LogCostParams): Promise<AiCostLog | null> {
  const isTranscription = params.operation === 'transcription';
  const isVision = params.operation === 'vision';
  const isEmbedding = params.operation === 'embedding';
  let cost: ComputedCost;
  if (isTranscription) {
    cost = calculateTranscriptionCost(params.durationMs ?? 0);
  } else if (isVision) {
    cost = calculateAttachmentCost(params.imageCount ?? 0, params.pdfCount ?? 0);
  } else if (isEmbedding) {
    cost = calculateEmbeddingCost(params.model, params.inputTokens);
  } else {
    cost = calculateCost(params.model, params.inputTokens, params.outputTokens);
  }
  const isLocal = params.isLocal ?? cost.isLocal;

  // Stamp operation-specific counters into metadata so analytics can
  // split "no usage reported" from "0-byte / 0-attachment clip".
  let metadata: Record<string, unknown> | undefined = params.metadata;
  if (isTranscription && params.durationMs !== undefined) {
    metadata = { ...(metadata ?? {}), durationMs: params.durationMs };
  }
  if (isVision) {
    metadata = {
      ...(metadata ?? {}),
      imageCount: params.imageCount ?? 0,
      pdfCount: params.pdfCount ?? 0,
    };
  }
  // A turn nobody could price is stored at $0 like a free one; this is what
  // tells them apart on the row (#813). A local turn is free, not unpriced.
  if (cost.unpriced && !isLocal) {
    metadata = { ...(metadata ?? {}), pricing: 'unknown' };
  }

  const data: Prisma.AiCostLogUncheckedCreateInput = {
    model: params.model,
    provider: params.provider,
    inputTokens: params.inputTokens,
    outputTokens: params.outputTokens,
    inputCostUsd: cost.inputCostUsd,
    outputCostUsd: cost.outputCostUsd,
    totalCostUsd: cost.totalCostUsd,
    isLocal,
    operation: params.operation,
  };
  if (params.agentId !== undefined) data.agentId = params.agentId;
  if (params.conversationId !== undefined) data.conversationId = params.conversationId;
  if (params.workflowExecutionId !== undefined) {
    data.workflowExecutionId = params.workflowExecutionId;
  }
  // Truthiness, not `!== undefined`: `null` (a user-less context) and `''` (a
  // caller forwarding an unset id) must both land as SQL NULL rather than as
  // an empty-string FK, which would fail the constraint and — because this
  // function swallows write errors by design — discard the whole cost row.
  // That is exactly how #654's summary rows were being lost.
  if (params.userId) data.userId = params.userId;
  if (metadata !== undefined) {
    data.metadata = metadata as Prisma.InputJsonValue;
  }
  // Empty strings (returned by the no-op tracer) are normalised away — only
  // real span IDs from a registered tracer land in the column.
  if (params.traceId) data.traceId = params.traceId;
  if (params.spanId) data.spanId = params.spanId;

  try {
    const row = await prisma.aiCostLog.create({ data });
    touchAgentLastActive(params.agentId, row.createdAt);
    // So this process's spend caps see the row before their cached totals expire.
    noteSpend(row.orgId, row.totalCostUsd, row.createdAt);
    logger.debug('Cost logged', {
      agentId: params.agentId,
      model: params.model,
      totalCostUsd: cost.totalCostUsd,
      operation: params.operation,
    });
    return row;
  } catch (err) {
    logger.error('Failed to persist AiCostLog row', {
      // All four foreign keys, because the commonest cause of this line is a
      // P2003 on one of them and the operator cannot tell which from the
      // Prisma message alone. Naming only agentId cost time on #599/#600/#654.
      agentId: params.agentId,
      conversationId: params.conversationId,
      workflowExecutionId: params.workflowExecutionId,
      userId: params.userId,
      model: params.model,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Aggregate an agent's costs over a date range into an `AgentCostSummary`
 * matching the shape already defined in `types/orchestration.ts`.
 *
 * Both `from` and `to` are **exclusive upper-bound** style: `from` is
 * inclusive (`>=`), `to` is exclusive (`<`). Pass a midnight boundary
 * for full-day coverage (e.g. `to: nextMidnight`), matching the pattern
 * used by `getCostBreakdown` in `cost-reports.ts`.
 */
export async function getAgentCosts(
  agentId: string,
  dateRange?: { from?: Date; to?: Date }
): Promise<AgentCostSummary> {
  const where = {
    agentId,
    ...(dateRange?.from || dateRange?.to
      ? {
          createdAt: {
            ...(dateRange.from ? { gte: dateRange.from } : {}),
            ...(dateRange.to ? { lt: dateRange.to } : {}),
          },
        }
      : {}),
  };

  const entries = await prisma.aiCostLog.findMany({ where, orderBy: { createdAt: 'desc' } });

  const summary: AgentCostSummary = {
    totalCostUsd: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    byProvider: {},
    byModel: {},
    byOperation: {},
    entries,
  };

  for (const row of entries) {
    summary.totalCostUsd += row.totalCostUsd;
    summary.totalInputTokens += row.inputTokens;
    summary.totalOutputTokens += row.outputTokens;
    summary.byProvider[row.provider] = (summary.byProvider[row.provider] ?? 0) + row.totalCostUsd;
    summary.byModel[row.model] = (summary.byModel[row.model] ?? 0) + row.totalCostUsd;
    summary.byOperation[row.operation] =
      (summary.byOperation[row.operation] ?? 0) + row.totalCostUsd;
  }

  return summary;
}

/**
 * Report whether an agent is within its monthly budget.
 *
 * "Month" is the current calendar month in UTC. Three caps apply, and the
 * agent is within budget only when it is within all three:
 *
 * - the agent's own `monthlyBudgetUsd` (none when unset);
 * - its org's `Org.settings.quotas.monthlyBudgetUsd` (none when unset), on the
 *   org's combined spend — surfaced as `orgCapExceeded: true`;
 * - the singleton `AiOrchestrationSettings.globalMonthlyBudgetUsd`, on every
 *   org's combined spend — surfaced as `globalCapExceeded: true`.
 *
 * The flags let the chat handler say which cap was hit. A failure reading the
 * org or global cap is logged and that cap skipped, so it never takes the
 * per-agent check down.
 *
 * Only chat calls this. The org and global caps are also enforced on every
 * paid vendor call by the provider manager's gate (`assertWithinSpendCaps` in
 * `spend-caps.ts`), which is what holds workflows, evaluations and every other
 * caller to them; chat checks first so the user is told which cap stopped the
 * turn. Their month-to-date totals are cached for a few seconds there, which
 * bounds how far another process's spend can carry a cap past its limit.
 *
 * Callers hold `withAgentBudgetLock`, which is keyed by agent: two agents in
 * one org can both pass the org check at once and each overrun the org cap by
 * up to one turn. The global cap has the same bound.
 */
export async function checkBudget(agentId: string): Promise<BudgetStatus> {
  const agent = await prisma.aiAgent.findUnique({
    where: { id: agentId },
    select: { monthlyBudgetUsd: true, orgId: true },
  });
  if (!agent) {
    throw new Error(`Agent ${agentId} not found`);
  }

  // Three independent reads. The org and global ones never reject: a cap that
  // cannot be read is logged and skipped, so it never takes the per-agent
  // check down.
  const [aggregate, global, org] = await Promise.all([
    prisma.aiCostLog.aggregate({
      where: { agentId, createdAt: { gte: utcMonthStart() } },
      _sum: { totalCostUsd: true },
    }),
    globalCapStateOrSkip({ agentId }),
    orgCapStateOrSkip(agent.orgId ?? null, { agentId }),
  ]);
  const spent = aggregate._sum.totalCostUsd ?? 0;
  const globalCapExceeded = global?.exceeded ?? false;
  const orgCapExceeded = org?.exceeded ?? false;

  const limit = agent.monthlyBudgetUsd ?? null;
  const withinAgentBudget = limit === null || spent < limit;
  return {
    withinBudget: withinAgentBudget && !orgCapExceeded && !globalCapExceeded,
    spent,
    limit,
    remaining: limit === null ? null : limit - spent,
    ...(globalCapExceeded ? { globalCapExceeded: true } : {}),
    ...(org ? { org: { limit: org.limit, spent: org.spent } } : {}),
    ...(orgCapExceeded ? { orgCapExceeded: true } : {}),
  };
}

// ----------------------------------------------------------------------------
// calculateLocalSavings
// ----------------------------------------------------------------------------

interface LocalRow {
  model: string;
  inputTokens: number;
  outputTokens: number;
}

function findCheapestNonLocalInTier(tier: ModelInfo['tier']): ModelInfo | null {
  const candidates = getAvailableModels()
    .filter((m) => m.tier === tier && m.tier !== 'local')
    .filter((m) => m.inputCostPerMillion > 0 || m.outputCostPerMillion > 0)
    .sort((a, b) => a.inputCostPerMillion - b.inputCostPerMillion);
  return candidates[0] ?? null;
}

/**
 * Hypothetical-cost savings from local models.
 *
 * For every `AiCostLog` row with `isLocal = true` in the window, price
 * the same token counts against the cheapest non-local model in the
 * same tier — the savings are (what-you-would-have-paid − 0). Local
 * rows always have local model ids, so there is never a direct
 * non-local equivalent to price against; `methodology` is therefore
 * always `'tier_fallback'`. The field is retained so future modes can
 * be added without a response-shape change.
 *
 * This helper never throws — on any unexpected error it logs and returns
 * a zero-savings result so the cost summary can still render.
 */
export async function calculateLocalSavings(opts: {
  dateFrom: Date;
  dateTo: Date;
}): Promise<LocalSavingsResult> {
  const { dateFrom, dateTo } = opts;
  const base: LocalSavingsResult = {
    usd: 0,
    methodology: 'tier_fallback',
    sampleSize: 0,
    dateFrom: dateFrom.toISOString(),
    dateTo: dateTo.toISOString(),
  };

  let rows: LocalRow[];
  try {
    rows = await prisma.aiCostLog.findMany({
      where: { isLocal: true, createdAt: { gte: dateFrom, lt: dateTo } },
      select: { model: true, inputTokens: true, outputTokens: true },
    });
  } catch (err) {
    logger.warn('calculateLocalSavings: query failed, returning zero savings', {
      error: err instanceof Error ? err.message : String(err),
    });
    return base;
  }

  if (rows.length === 0) return base;

  let totalUsd = 0;
  let contributing = 0;

  for (const row of rows) {
    const localModel = getModel(row.model);
    // Local rows have no direct non-local equivalent — walk up through
    // the reported tier (or `budget` as a default), falling back to
    // `mid` if neither yields a hosted reference.
    const tier = localModel?.tier ?? 'budget';
    const ref =
      findCheapestNonLocalInTier(tier === 'local' ? 'budget' : tier) ??
      findCheapestNonLocalInTier('budget') ??
      findCheapestNonLocalInTier('mid');

    if (!ref) continue;

    const rowSavings =
      (row.inputTokens * ref.inputCostPerMillion + row.outputTokens * ref.outputCostPerMillion) /
      1_000_000;
    totalUsd += rowSavings;
    contributing += 1;
  }

  return {
    usd: totalUsd,
    methodology: 'tier_fallback',
    sampleSize: contributing,
    dateFrom: dateFrom.toISOString(),
    dateTo: dateTo.toISOString(),
  };
}
