/**
 * Admin Orchestration — Execute workflow (STUB, 501)
 *
 * POST /api/v1/admin/orchestration/workflows/:id/execute
 *
 * The real `OrchestrationEngine` lands in Phase 5 (Session 5.2). This
 * route ships this session as a full handler that validates auth, body,
 * workflow existence, workflow activity, and DAG structure — everything
 * up to the engine boundary — then returns 501 `NOT_IMPLEMENTED`.
 *
 * The handler contract (shape, auth, validation, error codes) is stable
 * so Phase 4 UI work can build against it. Session 5.2 replaces the 501
 * line with an `engine.execute(...)` call and nothing else changes.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { validateWorkflow } from '@/lib/orchestration/workflows';
import { executeWorkflowBodySchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import type { WorkflowDefinition } from '@/types/orchestration';

const NOT_IMPLEMENTED_MESSAGE = 'Workflow execution engine arrives in Phase 5 (Session 5.2)';

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

  log.warn('workflow execute stubbed — 501', {
    workflowId: id,
    userId: session.user.id,
    budgetLimitUsd: body.budgetLimitUsd,
  });

  // TODO(Session 5.2): replace this 501 with
  //   return successResponse(
  //     await engine.execute({
  //       workflow,
  //       inputData: body.inputData,
  //       budgetLimitUsd: body.budgetLimitUsd,
  //       userId: session.user.id,
  //     })
  //   );
  return errorResponse(NOT_IMPLEMENTED_MESSAGE, {
    code: 'NOT_IMPLEMENTED',
    status: 501,
  });
});
