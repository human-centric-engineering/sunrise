/**
 * Prepare a failed run to resume from one of its failed steps.
 *
 * Cuts the trace back to the entries before the failed step, recalculates the
 * totals, points `currentStep` at the last kept entry and moves the run to
 * `pending`, ready for the client to resume it. The admin route
 * (`executions/:id/retry-step`) delegates here.
 *
 * Read and written in one transaction under the run's row lock (§122 t-901,
 * `withRunRowLocked`): the trace is written back whole, and a copy read before
 * an erasure would put the erased person back.
 */

import { Prisma, type AiWorkflowExecution } from '@prisma/client';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { withRunRowLocked } from '@/lib/orchestration/engine/run-row-lock';
import { executionTraceSchema } from '@/lib/validations/orchestration';
import { WorkflowStatus } from '@/types/orchestration';

/** What a prepared retry reports back. */
export interface PreparedRetry {
  workflowId: string;
  keptSteps: number;
}

/**
 * Throws `NotFoundError` when the run is missing or `canView` refuses it, and
 * `ValidationError` when it is not failed, its trace is corrupt, the step is
 * not a failed step in it, or another retry got there first.
 */
export function prepareRetryStep(
  executionId: string,
  stepId: string,
  canView: (execution: AiWorkflowExecution) => boolean
): Promise<PreparedRetry> {
  return withRunRowLocked(executionId, async (tx) => {
    const execution = await tx.aiWorkflowExecution.findUnique({ where: { id: executionId } });
    if (!execution || !canView(execution)) {
      throw new NotFoundError(`Execution ${executionId} not found`);
    }
    if (execution.status !== WorkflowStatus.FAILED) {
      throw new ValidationError('Execution is not in failed state', {
        status: [`Expected "failed", got "${execution.status}"`],
      });
    }

    const traceParse = executionTraceSchema.safeParse(execution.executionTrace);
    if (!traceParse.success) {
      throw new ValidationError('Execution trace is corrupted and cannot be modified');
    }
    const trace = traceParse.data;

    // Find the failed step in the trace
    const failedIdx = trace.findIndex((e) => e.stepId === stepId && e.status === 'failed');
    if (failedIdx === -1) {
      throw new ValidationError('Step not found in trace or is not failed', {
        stepId: [`Step "${stepId}" is not a failed step in this execution`],
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

    // Use PENDING (not RUNNING) to signal "ready to resume but no engine
    // attached yet". This prevents the zombie reaper from sweeping the row
    // before the client reconnects via ?resumeFromExecutionId=.
    //
    // Status in the WHERE too, so a concurrent retry that got the lock first
    // leaves this one matching nothing (count === 0).
    //
    // Defensive deleteMany of running-step rows: there should be none at
    // this point (finalize cleared on FAILED), but a crashed-mid-finalize
    // path could leave orphans. Atomic with the status flip so a
    // guard-failed retry doesn't sweep rows belonging to another path.
    const updated = await tx.aiWorkflowExecution.updateMany({
      where: { id: executionId, status: WorkflowStatus.FAILED },
      data: {
        status: WorkflowStatus.PENDING,
        executionTrace: keptTrace as unknown as Prisma.InputJsonValue,
        totalTokensUsed,
        totalCostUsd,
        currentStep,
        errorMessage: null,
        completedAt: null,
      },
    });
    if (updated.count === 0) {
      throw new ValidationError('Execution was already retried by another request', {
        status: ['Concurrent retry detected'],
      });
    }
    await tx.aiWorkflowRunningStep.deleteMany({ where: { executionId } });

    return { workflowId: execution.workflowId, keptSteps: keptTrace.length };
  });
}
