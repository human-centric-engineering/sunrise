/**
 * Admin Orchestration — Approve paused execution
 *
 * POST /api/v1/admin/orchestration/executions/:id/approve
 *
 * Transitions a `paused_for_approval` row back to `running` and writes
 * the approval payload onto the awaiting step's trace entry so the
 * engine sees it when the client reconnects via
 * `POST /workflows/:workflowId/execute?resumeFromExecutionId=<id>`.
 *
 * Ownership: the caller's own runs, plus system-owned runs (`userId = null`
 * — schedule- and inbound-triggered) where the authorization policy permits
 * an unattributed read, which a default install does. Another admin's own run
 * returns 404 (not 403) — we never confirm existence of a row the caller
 * cannot see.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError, ConflictError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { approveExecutionBodySchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { executeApproval } from '@/lib/orchestration/approval-actions';
import { isApproverInTrace } from '@/lib/orchestration/approval-scoping';
import {
  acrossOwnersForApproval,
  adminCanViewExecution,
} from '@/lib/orchestration/access/execution-access';
import { resumeApprovedExecution } from '@/lib/orchestration/scheduling';
import { keepRunningAfterResponse } from '@/lib/api/after-response';

/**
 * The invocation's budget, including the run drained after the response
 * (t-846). 300 s as on the maintenance tick. A run cut off by it is recovered
 * by a later tick: a `pending` row by the pending sweep, a `running` one by the
 * orphan sweep once its lease lapses, which uses one of its recovery attempts.
 */
export const maxDuration = 300;

export const POST = withAdminAuth<{ id: string }>(
  async (request, session, { params }) => {
    const { id: rawId } = await params;
    const parsed = cuidSchema.safeParse(rawId);
    if (!parsed.success) {
      throw new ValidationError('Invalid execution id', { id: ['Must be a valid CUID'] });
    }
    const id = parsed.data;

    const body = await validateRequestBody(request, approveExecutionBodySchema);

    // Ownership + approver scoping check. Read across owners: the nomination
    // is in the trace, so a named approver's run is one the owner layer would
    // otherwise refuse them (`acrossOwnersForApproval`).
    const execution = await acrossOwnersForApproval(() =>
      prisma.aiWorkflowExecution.findUnique({
        where: { id },
        select: { userId: true, executionTrace: true },
      })
    );
    if (!execution) {
      throw new NotFoundError(`Execution ${id} not found`);
    }

    // Allow if the caller may see the run — their own, or system-owned
    // (schedule- / inbound-triggered, `userId = null`) — or is in the
    // approverUserIds list. The system basis matters most here: a
    // system-owned run has no owner to fall back on, so without it an
    // approval gate reached by a scheduled or inbound run could never be
    // cleared by anyone (#502).
    const canAct = adminCanViewExecution(execution, session);
    const isApprover = !canAct && isApproverInTrace(execution.executionTrace, session.user.id);
    if (!canAct && !isApprover) {
      throw new NotFoundError(`Execution ${id} not found`);
    }

    try {
      const approve = () =>
        executeApproval(id, {
          notes: body.notes,
          approvalPayload: body.approvalPayload,
          actorLabel: `admin:${session.user.id}`,
        });
      const result = await (isApprover ? acrossOwnersForApproval(approve) : approve());
      // Background drain so the run continues immediately after approval
      // instead of waiting for the maintenance tick's `processPendingExecutions`
      // sweep (~2 min stale threshold + ~60s cron interval), kept alive past
      // the response (t-846). Matches the chat/embed approval routes in
      // `approval-route-helpers.ts`. The admin approvals UI already promises
      // "The workflow will resume" — this makes that promise true without
      // requiring an external cron caller.
      keepRunningAfterResponse(
        resumeApprovedExecution(id),
        'admin approve: resumeApprovedExecution',
        {
          executionId: id,
        }
      );
      return successResponse(result);
    } catch (err) {
      const error = err as Error & { code?: string; currentStatus?: string };
      switch (error.code) {
        case 'NOT_FOUND':
          throw new NotFoundError(error.message);
        case 'INVALID_STATUS':
          throw new ValidationError('Execution is not awaiting approval', {
            status: [`Expected "paused_for_approval", got "${error.currentStatus}"`],
          });
        case 'TRACE_CORRUPTED':
          throw new ValidationError('Execution trace is corrupted and cannot be modified');
        case 'CONCURRENT':
          throw new ConflictError('Execution was already approved by another request');
        default:
          throw err;
      }
    }
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
