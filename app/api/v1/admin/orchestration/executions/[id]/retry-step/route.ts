/**
 * Admin Orchestration — Retry failed step
 *
 * POST /api/v1/admin/orchestration/executions/:id/retry-step
 *
 * Prepares a `failed` execution for retry from a specific step. Removes
 * the failed step's trace entry (and any entries after it), recalculates
 * totals, sets `currentStep` to the step before the failed one, and
 * resets the execution status to `running`.
 *
 * After this call, the client reconnects via
 * `POST /workflows/:workflowId/execute?resumeFromExecutionId=<id>`
 * to resume streaming from the failed step.
 *
 * Follows the same ownership and pattern as the approve endpoint.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { retryStepBodySchema, executionTraceSchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { WorkflowStatus } from '@/types/orchestration';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid execution id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const body = await validateRequestBody(request, retryStepBodySchema);

  const execution = await prisma.aiWorkflowExecution.findUnique({ where: { id } });
  if (!execution || execution.userId !== session.user.id) {
    throw new NotFoundError(`Execution ${id} not found`);
  }
  if (execution.status !== WorkflowStatus.FAILED) {
    throw new ValidationError('Execution is not in failed state', {
      status: [`Expected "failed", got "${execution.status}"`],
    });
  }

  const trace = executionTraceSchema.parse(execution.executionTrace);

  // Find the failed step in the trace
  const failedIdx = trace.findIndex((e) => e.stepId === body.stepId && e.status === 'failed');
  if (failedIdx === -1) {
    throw new ValidationError('Step not found in trace or is not failed', {
      stepId: [`Step "${body.stepId}" is not a failed step in this execution`],
    });
  }

  // Truncate: keep only entries before the failed step
  const keptTrace = trace.slice(0, failedIdx);

  // Recalculate totals from kept entries
  let totalTokensUsed = 0;
  let totalCostUsd = 0;
  for (const entry of keptTrace) {
    totalTokensUsed += entry.tokensUsed;
    totalCostUsd += entry.costUsd;
  }

  // The currentStep should be the last completed step (so nextIdsAfter
  // returns the failed step). If no entries remain, clear currentStep
  // so the engine starts from entryStepId.
  const lastEntry = keptTrace.length > 0 ? keptTrace[keptTrace.length - 1] : null;
  const currentStep = lastEntry?.stepId ?? null;

  await prisma.aiWorkflowExecution.update({
    where: { id },
    data: {
      status: WorkflowStatus.RUNNING,
      executionTrace: keptTrace as unknown as object,
      totalTokensUsed,
      totalCostUsd,
      currentStep,
      errorMessage: null,
      completedAt: null,
    },
  });

  log.info('execution retry-step prepared', {
    executionId: id,
    userId: session.user.id,
    retryStepId: body.stepId,
    keptSteps: keptTrace.length,
  });

  return successResponse({
    success: true,
    executionId: id,
    retryStepId: body.stepId,
    workflowId: execution.workflowId,
  });
});
