/**
 * Admin Orchestration — Get execution live snapshot
 *
 * GET /api/v1/admin/orchestration/executions/:id/live
 *
 * Designed for high-frequency (~1s) polling from the execution detail page.
 * Returns everything the live view needs in one round-trip:
 *
 *   - `snapshot`           — the same narrow fields as `/status` (status,
 *                            currentStep, errorMessage, tokens, cost, dates).
 *   - `trace`              — persisted step trace (steps that have terminated).
 *   - `costEntries`        — per-LLM-call cost rows attributed to this run.
 *   - `currentStepDetails` — { stepId, label, type, startedAt } when the
 *                            execution is in a running/paused status AND the
 *                            engine has written the live-running columns.
 *                            Null otherwise.
 *
 * `currentStepDetails` is sourced from the `currentStep*` columns on
 * `AiWorkflowExecution` (populated by `markCurrentStep` in the engine) so
 * we don't have to parse the workflow version snapshot per poll.
 *
 * Ownership: rows are scoped to `session.user.id`. Cross-user access
 * returns 404 (not 403) — we never confirm existence of another user's row.
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

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

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
    select: {
      id: true,
      userId: true,
      status: true,
      currentStep: true,
      currentStepLabel: true,
      currentStepType: true,
      currentStepStartedAt: true,
      errorMessage: true,
      totalTokensUsed: true,
      totalCostUsd: true,
      startedAt: true,
      completedAt: true,
      createdAt: true,
      executionTrace: true,
    },
  });
  if (!execution || execution.userId !== session.user.id) {
    throw new NotFoundError(`Execution ${id} not found`);
  }

  const trace = executionTraceSchema.parse(execution.executionTrace);

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

  // Only surface running-step details for non-terminal executions whose
  // live columns are all populated. Terminal rows (and rows whose engine
  // hasn't yet entered a step) get null so the UI can drop the running
  // indicator cleanly.
  const isTerminal = TERMINAL_STATUSES.has(execution.status);
  const currentStepDetails =
    !isTerminal &&
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
    snapshot: {
      id: execution.id,
      status: execution.status,
      currentStep: execution.currentStep,
      errorMessage: execution.errorMessage,
      totalTokensUsed: execution.totalTokensUsed,
      totalCostUsd: execution.totalCostUsd,
      startedAt: execution.startedAt,
      completedAt: execution.completedAt,
      createdAt: execution.createdAt,
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
