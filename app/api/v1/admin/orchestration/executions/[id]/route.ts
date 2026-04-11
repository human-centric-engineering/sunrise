/**
 * Admin Orchestration — Get execution (STUB, 501)
 *
 * GET /api/v1/admin/orchestration/executions/:id
 *
 * The `AiWorkflowExecution` row already exists in the schema (with
 * `status`, `executionTrace`, `currentStep`, `errorMessage`, and
 * `totalCostUsd`), but there's no engine writing to it yet. This route
 * ships this session as a full handler that proves auth + id parsing +
 * row lookup, and returns 501 when the row is found so the contract is
 * exercised end-to-end before Session 5.2 plugs in the engine.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';

const NOT_IMPLEMENTED_MESSAGE = 'Workflow execution engine arrives in Phase 5 (Session 5.2)';

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid execution id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const execution = await prisma.aiWorkflowExecution.findUnique({ where: { id } });
  if (!execution) throw new NotFoundError(`Execution ${id} not found`);

  log.warn('execution GET stubbed — 501', { executionId: id });

  // TODO(Session 5.2): replace this 501 with
  //   return successResponse(execution);
  return errorResponse(NOT_IMPLEMENTED_MESSAGE, {
    code: 'NOT_IMPLEMENTED',
    status: 501,
  });
});
