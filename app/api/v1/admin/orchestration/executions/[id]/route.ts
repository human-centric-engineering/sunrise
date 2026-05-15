/**
 * Admin Orchestration — Get execution detail
 *
 * GET /api/v1/admin/orchestration/executions/:id
 *
 * Returns the `AiWorkflowExecution` row plus a parsed `trace` array, a
 * small projection suitable for the execution panel UI, and `costEntries`
 * — an unrolled view of the `AiCostLog` rows attributed to this run, used
 * by the trace viewer to break down per-step LLM cost.
 *
 * The `costEntries` array carries one row per LLM call. For multi-turn
 * executors (`tool_call`, `agent_call`, `orchestrator`) several entries
 * share a `stepId`; the UI groups them client-side. Entries with no
 * `metadata.stepId` are dropped — only step-attributed cost surfaces here
 * (chat/conversation cost has its own surfaces).
 *
 * Ownership: rows are scoped to `session.user.id`. Cross-user access
 * returns 404 (not 403) — we never confirm existence of another user's
 * row.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { executionTraceSchema } from '@/lib/validations/orchestration';

// `executionTraceSchema` is `z.array(...).catch([])` — parsing always succeeds,
// returning `[]` for malformed rows. Don't add a "trace corrupted" error path
// here: it would be unreachable and gives the wrong impression that this
// route guards against bad data with a 400.

interface CostEntry {
  stepId: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
  operation: string;
  createdAt: string;
}

export const GET = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid execution id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const execution = await prisma.aiWorkflowExecution.findUnique({
    where: { id },
    include: { workflow: { select: { id: true, name: true } } },
  });
  if (!execution || execution.userId !== session.user.id) {
    throw new NotFoundError(`Execution ${id} not found`);
  }

  const trace = executionTraceSchema.parse(execution.executionTrace);

  // Pull every cost log attributed to this execution. Older rows in
  // production may have null metadata or no stepId — those are filtered
  // out below so we only surface step-attributed cost. Sorted ASC by
  // createdAt so multi-turn entries appear in the order the LLM saw them.
  const costLogs = await prisma.aiCostLog.findMany({
    where: { workflowExecutionId: id },
    orderBy: { createdAt: 'asc' },
    select: {
      model: true,
      provider: true,
      inputTokens: true,
      outputTokens: true,
      totalCostUsd: true,
      operation: true,
      metadata: true,
      createdAt: true,
    },
  });

  const costEntries: CostEntry[] = [];
  for (const row of costLogs) {
    const stepId = extractStepId(row.metadata);
    if (!stepId) continue;
    costEntries.push({
      stepId,
      model: row.model,
      provider: row.provider,
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      totalCostUsd: row.totalCostUsd,
      operation: row.operation,
      createdAt: row.createdAt.toISOString(),
    });
  }

  // `currentStepDetails` mirrors the shape returned by /executions/:id/live so
  // the page's initial paint can seed the live-poll hook directly. Only
  // populated when status is non-terminal AND all three live columns are set.
  const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
  const currentStepDetails =
    !TERMINAL_STATUSES.has(execution.status) &&
    execution.currentStep &&
    execution.currentStepLabel &&
    execution.currentStepType &&
    execution.currentStepStartedAt
      ? {
          stepId: execution.currentStep,
          label: execution.currentStepLabel,
          stepType: execution.currentStepType,
          startedAt: execution.currentStepStartedAt.toISOString(),
        }
      : null;

  return successResponse({
    execution: {
      id: execution.id,
      workflowId: execution.workflowId,
      status: execution.status,
      totalTokensUsed: execution.totalTokensUsed,
      totalCostUsd: execution.totalCostUsd,
      budgetLimitUsd: execution.budgetLimitUsd,
      currentStep: execution.currentStep,
      inputData: execution.inputData,
      outputData: execution.outputData,
      errorMessage: execution.errorMessage,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      createdAt: execution.createdAt,
      workflow: { id: execution.workflow.id, name: execution.workflow.name },
    },
    trace,
    costEntries,
    currentStepDetails,
  });
});

function extractStepId(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== 'object') return null;
  const value = (metadata as { stepId?: unknown }).stepId;
  return typeof value === 'string' && value.length > 0 ? value : null;
}
