/**
 * Cost Tracker
 *
 * Computes the USD cost of an LLM operation using the model registry,
 * writes granular cost rows to `AiCostLog`, aggregates spend by agent,
 * and enforces per-agent monthly budgets.
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
import { getAvailableModels, getModel } from './model-registry';
import type { AgentCostSummary, CostOperation, LocalSavingsResult } from '@/types/orchestration';
import type { ModelInfo } from './types';

/** Computed cost breakdown for a single operation. */
export interface ComputedCost {
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
  /** True when the model was resolved from the local tier (or not found). */
  isLocal: boolean;
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
  /** Explicit override; otherwise inferred from the model registry tier. */
  isLocal?: boolean;
  metadata?: Record<string, unknown>;
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
}

/**
 * Compute the USD cost of an operation for the given model and token
 * counts. Returns zeroed costs for local models and for models not
 * present in the registry (logs a warning so the model can be added).
 */
export function calculateCost(
  modelId: string,
  inputTokens: number,
  outputTokens: number
): ComputedCost {
  const model = getModel(modelId);
  if (!model) {
    logger.warn('Cost calculation: unknown model, treating as zero cost', { model: modelId });
    return { inputCostUsd: 0, outputCostUsd: 0, totalCostUsd: 0, isLocal: true };
  }

  if (model.tier === 'local') {
    return { inputCostUsd: 0, outputCostUsd: 0, totalCostUsd: 0, isLocal: true };
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
 */
export async function logCost(params: LogCostParams): Promise<AiCostLog | null> {
  const cost = calculateCost(params.model, params.inputTokens, params.outputTokens);
  const isLocal = params.isLocal ?? cost.isLocal;

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
  if (params.metadata !== undefined) {
    data.metadata = params.metadata as Prisma.InputJsonValue;
  }

  try {
    const row = await prisma.aiCostLog.create({ data });
    logger.debug('Cost logged', {
      agentId: params.agentId,
      model: params.model,
      totalCostUsd: cost.totalCostUsd,
      operation: params.operation,
    });
    return row;
  } catch (err) {
    logger.error('Failed to persist AiCostLog row', {
      agentId: params.agentId,
      model: params.model,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Aggregate an agent's costs over a date range into an `AgentCostSummary`
 * matching the shape already defined in `types/orchestration.ts`.
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
            ...(dateRange.to ? { lte: dateRange.to } : {}),
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
 * Sum of every `AiCostLog.totalCostUsd` row created since the start of
 * the current UTC calendar month, across all agents. Used by the global
 * budget cap in `checkBudget` and by surfaces that show platform-wide
 * spend.
 */
export async function getMonthToDateGlobalSpend(): Promise<number> {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const aggregate = await prisma.aiCostLog.aggregate({
    where: { createdAt: { gte: monthStart } },
    _sum: { totalCostUsd: true },
  });
  return aggregate._sum.totalCostUsd ?? 0;
}

/**
 * Report whether an agent is within its monthly budget.
 *
 * "Month" is the current calendar month in UTC. Agents without a
 * `monthlyBudgetUsd` are within the per-agent budget. Independently,
 * the singleton `AiOrchestrationSettings.globalMonthlyBudgetUsd` (if
 * set) imposes a month-to-date ceiling across the combined spend of
 * all agents. A global breach surfaces as `globalCapExceeded: true`
 * so the chat handler can distinguish it from a per-agent breach.
 */
export async function checkBudget(agentId: string): Promise<BudgetStatus> {
  const agent = await prisma.aiAgent.findUnique({
    where: { id: agentId },
    select: { monthlyBudgetUsd: true },
  });
  if (!agent) {
    throw new Error(`Agent ${agentId} not found`);
  }

  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const aggregate = await prisma.aiCostLog.aggregate({
    where: { agentId, createdAt: { gte: monthStart } },
    _sum: { totalCostUsd: true },
  });
  const spent = aggregate._sum.totalCostUsd ?? 0;

  // Global-cap check comes first so an exhausted platform cap surfaces
  // distinctly even for agents that have their own per-agent budget set.
  let globalCapExceeded = false;
  try {
    const settings = await prisma.aiOrchestrationSettings.findUnique({
      where: { slug: 'global' },
      select: { globalMonthlyBudgetUsd: true },
    });
    const globalCap = settings?.globalMonthlyBudgetUsd ?? null;
    if (globalCap !== null) {
      const globalSpent = await getMonthToDateGlobalSpend();
      if (globalSpent >= globalCap) {
        globalCapExceeded = true;
      }
    }
  } catch (err) {
    // Settings lookup must never take the per-agent path down.
    logger.warn('checkBudget: global cap lookup failed, falling back to per-agent only', {
      agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (agent.monthlyBudgetUsd === null || agent.monthlyBudgetUsd === undefined) {
    return {
      withinBudget: !globalCapExceeded,
      spent,
      limit: null,
      remaining: null,
      ...(globalCapExceeded ? { globalCapExceeded: true } : {}),
    };
  }

  const withinAgentBudget = spent < agent.monthlyBudgetUsd;
  return {
    withinBudget: withinAgentBudget && !globalCapExceeded,
    spent,
    limit: agent.monthlyBudgetUsd,
    remaining: agent.monthlyBudgetUsd - spent,
    ...(globalCapExceeded ? { globalCapExceeded: true } : {}),
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
      where: { isLocal: true, createdAt: { gte: dateFrom, lte: dateTo } },
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
