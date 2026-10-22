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
 * Follows the same pattern as the approve endpoint, but **not** the same
 * ownership: `approve` additionally admits an admin the run's trace names in
 * `approverUserIds`, and this route has no such arm. Under a policy that denies
 * unattributed reads, a delegated approver who released a gate on a system-owned
 * run gets a 404 here if that run later fails at some other step — not on the
 * step they released, which is `completed` and would be a 400 for its owner
 * too.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { retryStepBodySchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { adminCanViewExecution } from '@/lib/orchestration/access/execution-access';
import { prepareRetryStep } from '@/lib/orchestration/retry-step';

export const POST = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
    const log = await getRouteLogger(request);
    const { id: rawId } = await params;
    const parsed = cuidSchema.safeParse(rawId);
    if (!parsed.success) {
      throw new ValidationError('Invalid execution id', { id: ['Must be a valid CUID'] });
    }
    const id = parsed.data;

    const body = await validateRequestBody(request, retryStepBodySchema);

    const { workflowId, keptSteps } = await prepareRetryStep(id, body.stepId, (execution) =>
      adminCanViewExecution(execution, session)
    );

    log.info('execution retry-step prepared', {
      executionId: id,
      userId: session.user.id,
      retryStepId: body.stepId,
      keptSteps,
    });

    return successResponse({
      success: true,
      executionId: id,
      retryStepId: body.stepId,
      workflowId,
    });
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'self',
      because:
        "Acts only on executions this caller may see — their own, an ownerless (scheduled or inbound) run where the policy permits it, or one whose trace names them as an approver — keyed on the caller's id.",
    },
  }
);
