/**
 * Admin Orchestration — Execute workflow
 *
 * POST /api/v1/admin/orchestration/workflows/:id/execute
 *
 * Instantiates `OrchestrationEngine` and streams `ExecutionEvent`s back
 * to the client via `sseResponse()`. Platform-agnostic engine code lives
 * in `lib/orchestration/engine/`; this route only handles auth, rate
 * limit, validation, and the SSE bridge.
 *
 * Resume: when the client passes `?resumeFromExecutionId=<cuid>`, the
 * engine continues the named run instead of creating a new row. Used by
 * the `human_approval` flow after the reviewer POSTs to
 * `/executions/:id/approve`.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { sseResponse } from '@/lib/api/sse';
import { validateWorkflow } from '@/lib/orchestration/workflows';
import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import {
  executeWorkflowBodySchema,
  resumeExecutionQuerySchema,
} from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import type { WorkflowDefinition } from '@/types/orchestration';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid workflow id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const body = await validateRequestBody(request, executeWorkflowBodySchema);

  // Query params — resume support.
  const url = new URL(request.url);
  const queryParsed = resumeExecutionQuerySchema.safeParse({
    resumeFromExecutionId: url.searchParams.get('resumeFromExecutionId') ?? undefined,
  });
  if (!queryParsed.success) {
    throw new ValidationError('Invalid query parameters', {
      resumeFromExecutionId: ['Must be a valid CUID'],
    });
  }
  const { resumeFromExecutionId } = queryParsed.data;

  const workflow = await prisma.aiWorkflow.findUnique({ where: { id } });
  if (!workflow) throw new NotFoundError(`Workflow ${id} not found`);

  if (!workflow.isActive) {
    throw new ValidationError(`Workflow ${id} is not active`, {
      isActive: ['Workflow must be active before it can be executed'],
    });
  }

  // Pre-flight DAG validation — same shape clients get from /validate.
  const definition = workflow.workflowDefinition as unknown as WorkflowDefinition;
  const dag = validateWorkflow(definition);
  if (!dag.ok) {
    throw new ValidationError(`Workflow ${id} has a structurally invalid definition`, {
      workflowDefinition: dag.errors,
    });
  }

  // Resume-path ownership guard — cross-user resume returns 404 (not 403)
  // to avoid confirming existence of another user's execution.
  if (resumeFromExecutionId) {
    const existing = await prisma.aiWorkflowExecution.findUnique({
      where: { id: resumeFromExecutionId },
      select: { id: true, userId: true, workflowId: true },
    });
    if (!existing || existing.userId !== session.user.id || existing.workflowId !== id) {
      throw new NotFoundError(`Execution ${resumeFromExecutionId} not found`);
    }
  }

  log.info('workflow execute started', {
    workflowId: id,
    userId: session.user.id,
    budgetLimitUsd: body.budgetLimitUsd,
    resumeFromExecutionId,
  });

  const engine = new OrchestrationEngine();
  const events = engine.execute({ id: workflow.id, definition }, body.inputData, {
    userId: session.user.id,
    budgetLimitUsd: body.budgetLimitUsd,
    signal: request.signal,
    resumeFromExecutionId,
  });

  return sseResponse(events, { signal: request.signal });
});
