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
import { getModel } from './model-registry';
import type { CostOperation, CostSummary } from '@/types/orchestration';

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
 * Aggregate an agent's costs over a date range into a `CostSummary`
 * matching the shape already defined in `types/orchestration.ts`.
 */
export async function getAgentCosts(
  agentId: string,
  dateRange?: { from?: Date; to?: Date }
): Promise<CostSummary> {
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

  const summary: CostSummary = {
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
 * "Month" is the current calendar month in UTC. Agents without a
 * `monthlyBudgetUsd` are always reported as within budget, with
 * `limit` and `remaining` set to `null`.
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

  if (agent.monthlyBudgetUsd === null || agent.monthlyBudgetUsd === undefined) {
    return { withinBudget: true, spent, limit: null, remaining: null };
  }

  return {
    withinBudget: spent < agent.monthlyBudgetUsd,
    spent,
    limit: agent.monthlyBudgetUsd,
    remaining: agent.monthlyBudgetUsd - spent,
  };
}
