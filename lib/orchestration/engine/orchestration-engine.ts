/**
 * OrchestrationEngine — platform-agnostic workflow executor.
 *
 * Mirrors `streamChat()` from `lib/orchestration/chat/streaming-handler.ts`:
 * returns an `AsyncIterable<ExecutionEvent>` that the API layer hands
 * to `sseResponse()` for SSE delivery. No Next.js, no Response, no
 * `NextRequest` — the engine never knows it's being served over HTTP.
 *
 * Lifecycle of a run:
 *
 *   1. `execute()` is called with a validated `WorkflowDefinition`,
 *      `inputData`, and `{ userId, budgetLimitUsd?, signal? }`.
 *   2. The engine creates an `AiWorkflowExecution` row (`status: 'running'`,
 *      empty trace) and yields `workflow_started`.
 *   3. Starting from `entryStepId`, the engine walks the DAG step by step:
 *        a. Emit `step_started`.
 *        b. Invoke the executor from the registry, wrapping it in the
 *           step's `errorStrategy` (`retry` / `fallback` / `skip` / `fail`).
 *        c. Merge the result into context, append a trace entry,
 *           checkpoint the DB row.
 *        d. Emit `step_completed`.
 *        e. Budget check — emit `budget_warning` at 80%, `workflow_failed`
 *           on overrun.
 *   4. Terminal event (`workflow_completed` / `workflow_failed`) flips
 *      the row's final status and sets `completedAt`.
 *
 * Error strategies (applied inside `runStepWithStrategy`):
 *
 *   - `retry`    → re-invoke the executor up to `retryCount` times
 *                  (default 2) with exponential backoff.
 *   - `fallback` → invoke `fallbackStepId` if present; otherwise behave
 *                  as `skip`.
 *   - `skip`     → emit `step_failed { willRetry: false }` and continue
 *                  with `output: null` in place of the failed step.
 *   - `fail`     → emit `step_failed` then `workflow_failed`, stop.
 *
 * The `PausedForApproval` error from the `human_approval` executor is
 * caught specifically: the row is flipped to `paused_for_approval`, an
 * `approval_required` event is yielded, and iteration stops cleanly.
 * The client is expected to POST to `/executions/:id/approve` and then
 * reconnect via `?resumeFromExecutionId=` to continue — resume plumbing
 * is provided by the route layer.
 */

import { Prisma } from '@prisma/client';
import { createLogger, type Logger } from '@/lib/logging';
import { prisma } from '@/lib/db/client';
import { executionTraceEntrySchema, stepErrorConfigSchema } from '@/lib/validations/orchestration';
import {
  WorkflowStatus,
  type ExecutionEvent,
  type ExecutionTraceEntry,
  type StepResult,
  type WorkflowDefinition,
  type WorkflowStep,
} from '@/types/orchestration';
import {
  createContext,
  mergeStepResult,
  snapshotContext,
  type ExecutionContext,
} from '@/lib/orchestration/engine/context';
import {
  BudgetExceeded,
  ExecutorError,
  PausedForApproval,
} from '@/lib/orchestration/engine/errors';
import {
  approvalRequired,
  budgetWarning,
  stepCompleted,
  stepFailed,
  stepStarted,
  workflowCompleted,
  workflowFailed,
  workflowStarted,
} from '@/lib/orchestration/engine/events';
import { getExecutor } from '@/lib/orchestration/engine/executor-registry';

// Ensure every executor self-registers before the engine touches the
// registry. Importing for side effects.
import '@/lib/orchestration/engine/executors';

/** Default retry count for `retry` strategy. */
const DEFAULT_RETRY_COUNT = 2;

/** Budget-warning threshold (fraction of `budgetLimitUsd`). */
const BUDGET_WARN_FRACTION = 0.8;

/** Hard cap on steps walked in a single run — guards against pathological loops. */
const MAX_STEPS_PER_RUN = 1000;

export interface ExecuteOptions {
  userId: string;
  budgetLimitUsd?: number;
  signal?: AbortSignal;
  /**
   * When set, the engine resumes from the named execution row instead
   * of creating a new one. Used by the approval flow to continue a
   * `paused_for_approval` run.
   */
  resumeFromExecutionId?: string;
}

export interface ExecuteWorkflowArg {
  id: string;
  definition: WorkflowDefinition;
}

export class OrchestrationEngine {
  async *execute(
    workflow: ExecuteWorkflowArg,
    inputData: Record<string, unknown>,
    options: ExecuteOptions
  ): AsyncIterable<ExecutionEvent> {
    const baseLogger = createLogger({
      workflowId: workflow.id,
      userId: options.userId,
    });

    // --------------------------------------------------------------
    // 1. Row creation / resume
    // --------------------------------------------------------------
    const { executionId, trace, budgetLimitUsd, ctx, resumeAfterStepId } = await this.initRun(
      workflow,
      inputData,
      options,
      baseLogger
    );

    yield workflowStarted(executionId, workflow.id);

    // --------------------------------------------------------------
    // 2. DAG walk
    // --------------------------------------------------------------
    const byId = new Map(workflow.definition.steps.map((s) => [s.id, s]));
    const visited = new Set<string>();
    const queue: string[] = resumeAfterStepId
      ? this.nextIdsAfter(byId, resumeAfterStepId)
      : [workflow.definition.entryStepId];

    let stepCount = 0;
    let finalOutput: unknown = null;
    let failed = false;
    let failureReason: string | null = null;

    while (queue.length > 0) {
      if (options.signal?.aborted) {
        failureReason = 'Execution aborted by client';
        yield workflowFailed(failureReason);
        failed = true;
        break;
      }

      // Check if the execution was cancelled via the cancel endpoint.
      const row = await prisma.aiWorkflowExecution.findUnique({
        where: { id: ctx.executionId },
        select: { status: true },
      });
      if (row?.status === WorkflowStatus.CANCELLED) {
        failureReason = 'Execution cancelled by user';
        yield workflowFailed(failureReason);
        failed = true;
        break;
      }

      if (stepCount++ >= MAX_STEPS_PER_RUN) {
        failureReason = `Step count exceeded ${MAX_STEPS_PER_RUN}`;
        yield workflowFailed(failureReason);
        failed = true;
        break;
      }

      const stepId = queue.shift() as string;
      if (visited.has(stepId)) continue;
      const step = byId.get(stepId);
      if (!step) {
        failureReason = `Unknown step id "${stepId}"`;
        yield workflowFailed(failureReason, stepId);
        failed = true;
        break;
      }
      visited.add(stepId);

      yield stepStarted(step.id, step.type, step.name);

      await this.markCurrentStep(executionId, step.id);

      const started = Date.now();
      let stepResult: StepResult | null = null;
      let stepError: ExecutorError | null = null;

      try {
        stepResult = yield* this.runStepWithStrategy(step, ctx);
      } catch (err) {
        if (err instanceof PausedForApproval) {
          // Paused — record the trace entry with `awaiting_approval`,
          // flip the row, and exit cleanly.
          const durationMs = Date.now() - started;
          trace.push({
            stepId: step.id,
            stepType: step.type,
            label: step.name,
            status: 'awaiting_approval',
            output: err.payload,
            tokensUsed: 0,
            costUsd: 0,
            startedAt: new Date(started).toISOString(),
            completedAt: new Date().toISOString(),
            durationMs,
          });
          await this.pauseForApproval(executionId, ctx, trace, step.id);
          yield approvalRequired(step.id, err.payload);
          return;
        }
        if (err instanceof BudgetExceeded) {
          failureReason = 'Budget exceeded';
          yield workflowFailed(failureReason, step.id);
          failed = true;
          break;
        }
        stepError =
          err instanceof ExecutorError
            ? err
            : new ExecutorError(
                step.id,
                'executor_threw',
                err instanceof Error ? err.message : 'Executor threw an unknown error',
                err
              );
      }

      const durationMs = Date.now() - started;

      if (stepError) {
        baseLogger.error('Workflow step failed', stepError, {
          executionId,
          stepId: step.id,
          code: stepError.code,
        });
        trace.push({
          stepId: step.id,
          stepType: step.type,
          label: step.name,
          status: 'failed',
          output: null,
          error: sanitizeError(stepError),
          tokensUsed: 0,
          costUsd: 0,
          startedAt: new Date(started).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs,
        });
        await this.checkpoint(executionId, ctx, trace);
        failureReason = sanitizeError(stepError);
        yield workflowFailed(failureReason, step.id);
        failed = true;
        break;
      }

      // stepResult must be non-null here because the above branches
      // either returned or set stepError.
      const result = stepResult as StepResult;
      mergeStepResult(ctx, step.id, result);
      trace.push({
        stepId: step.id,
        stepType: step.type,
        label: step.name,
        status: 'completed',
        output: result.output,
        tokensUsed: result.tokensUsed,
        costUsd: result.costUsd,
        startedAt: new Date(started).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs,
      });
      await this.checkpoint(executionId, ctx, trace);

      yield stepCompleted(step.id, result.output, result.tokensUsed, result.costUsd, durationMs);

      finalOutput = result.output;

      // Budget check
      if (budgetLimitUsd && ctx.totalCostUsd > budgetLimitUsd) {
        failureReason = 'Budget exceeded';
        yield workflowFailed(failureReason, step.id);
        failed = true;
        break;
      }
      if (
        budgetLimitUsd &&
        ctx.totalCostUsd >= budgetLimitUsd * BUDGET_WARN_FRACTION &&
        !ctx.variables.__budgetWarned
      ) {
        ctx.variables.__budgetWarned = true;
        yield budgetWarning(ctx.totalCostUsd, budgetLimitUsd);
      }

      if (result.terminal) break;

      // Enqueue next steps.
      const nextIds =
        result.nextStepIds && result.nextStepIds.length > 0
          ? result.nextStepIds
          : step.nextSteps.map((edge) => edge.targetStepId);
      for (const id of nextIds) {
        if (!visited.has(id)) queue.push(id);
      }
    }

    // --------------------------------------------------------------
    // 3. Terminal event
    // --------------------------------------------------------------
    if (!failed) {
      await this.finalize(executionId, ctx, trace, WorkflowStatus.COMPLETED, null);
      yield workflowCompleted(finalOutput, ctx.totalTokensUsed, ctx.totalCostUsd);
    } else {
      await this.finalize(
        executionId,
        ctx,
        trace,
        WorkflowStatus.FAILED,
        failureReason ?? 'Execution did not complete'
      );
    }
  }

  // ================================================================
  // Private helpers
  // ================================================================

  /**
   * Run a single step with retry / fallback / skip / fail semantics.
   * Yields `step_failed` events for retries so the client sees them.
   * Returns the successful `StepResult` or throws an `ExecutorError`.
   *
   * Per-step timeout: if `config.timeoutMs` is set, the executor is
   * aborted after that many milliseconds. The timeout wraps the entire
   * step (including all retry attempts).
   */
  private async *runStepWithStrategy(
    step: WorkflowStep,
    ctx: ExecutionContext
  ): AsyncGenerator<ExecutionEvent, StepResult, unknown> {
    const executor = getExecutor(step.type);
    const errorConfig = stepErrorConfigSchema.parse(step.config);
    const strategy = errorConfig.errorStrategy ?? ctx.defaultErrorStrategy ?? 'fail';
    const retryCount =
      typeof errorConfig.retryCount === 'number' ? errorConfig.retryCount : DEFAULT_RETRY_COUNT;
    const stepTimeoutMs = errorConfig.timeoutMs;

    // Wrap the executor call with an optional per-step timeout.
    const invokeExecutor = async (): Promise<StepResult> => {
      if (!stepTimeoutMs) {
        return executor(step, snapshotContext(ctx));
      }
      return Promise.race([
        executor(step, snapshotContext(ctx)),
        new Promise<never>((_, reject) => {
          setTimeout(
            () =>
              reject(
                new ExecutorError(
                  step.id,
                  'step_timeout',
                  `Step "${step.name}" timed out after ${stepTimeoutMs}ms`,
                  undefined,
                  false
                )
              ),
            stepTimeoutMs
          );
        }),
      ]);
    };

    if (strategy === 'retry') {
      let lastError: ExecutorError | null = null;
      for (let attempt = 0; attempt <= retryCount; attempt++) {
        try {
          return await invokeExecutor();
        } catch (err) {
          if (err instanceof PausedForApproval) throw err;
          lastError =
            err instanceof ExecutorError
              ? err
              : new ExecutorError(
                  step.id,
                  'executor_threw',
                  err instanceof Error ? err.message : 'Executor threw an unknown error',
                  err
                );
          // Don't retry non-retriable errors.
          if (!lastError.retriable) throw lastError;
          if (attempt < retryCount) {
            yield stepFailed(step.id, sanitizeError(lastError), true);
            await sleep(backoffDelayMs(attempt));
          }
        }
      }
      // Exhausted retries — rethrow the last error.
      throw lastError ?? new ExecutorError(step.id, 'retry_exhausted', 'Retry exhausted');
    }

    try {
      return await invokeExecutor();
    } catch (err) {
      if (err instanceof PausedForApproval) throw err;
      const execErr =
        err instanceof ExecutorError
          ? err
          : new ExecutorError(
              step.id,
              'executor_threw',
              err instanceof Error ? err.message : 'Executor threw an unknown error',
              err
            );

      if (strategy === 'skip') {
        yield stepFailed(step.id, sanitizeError(execErr), false);
        return { output: null, tokensUsed: 0, costUsd: 0 };
      }

      if (strategy === 'fallback') {
        yield stepFailed(step.id, sanitizeError(execErr), false);
        if (errorConfig.fallbackStepId) {
          return {
            output: null,
            tokensUsed: 0,
            costUsd: 0,
            nextStepIds: [errorConfig.fallbackStepId],
          };
        }
        return { output: null, tokensUsed: 0, costUsd: 0 };
      }

      // strategy === 'fail' — propagate.
      throw execErr;
    }
  }

  /**
   * Create (or load) the `AiWorkflowExecution` row and build the
   * execution context. Returns everything the walker needs.
   */
  private async initRun(
    workflow: ExecuteWorkflowArg,
    inputData: Record<string, unknown>,
    options: ExecuteOptions,
    baseLogger: Logger
  ): Promise<{
    executionId: string;
    trace: ExecutionTraceEntry[];
    budgetLimitUsd?: number;
    ctx: ExecutionContext;
    resumeAfterStepId?: string;
  }> {
    if (options.resumeFromExecutionId) {
      const row = await prisma.aiWorkflowExecution.findUnique({
        where: { id: options.resumeFromExecutionId },
      });
      if (!row) {
        throw new Error(`Execution row ${options.resumeFromExecutionId} not found`);
      }
      const rawTrace = row.executionTrace;
      const trace: ExecutionTraceEntry[] = Array.isArray(rawTrace)
        ? rawTrace.flatMap((entry) => {
            const parsed = executionTraceEntrySchema.safeParse(entry);
            return parsed.success ? [parsed.data as ExecutionTraceEntry] : [];
          })
        : [];
      const ctx = createContext({
        executionId: row.id,
        workflowId: workflow.id,
        userId: options.userId,
        inputData,
        defaultErrorStrategy: workflow.definition.errorStrategy,
        budgetLimitUsd: row.budgetLimitUsd ?? options.budgetLimitUsd,
        signal: options.signal,
        logger: baseLogger.withContext({ executionId: row.id }),
      });
      // Rehydrate cumulative totals and stepOutputs from the trace.
      ctx.totalTokensUsed = row.totalTokensUsed;
      ctx.totalCostUsd = row.totalCostUsd;
      for (const entry of trace) {
        if (entry.status === 'completed') {
          ctx.stepOutputs[entry.stepId] = entry.output;
        }
      }
      await prisma.aiWorkflowExecution.update({
        where: { id: row.id },
        data: { status: WorkflowStatus.RUNNING, startedAt: row.startedAt ?? new Date() },
      });
      return {
        executionId: row.id,
        trace,
        budgetLimitUsd: ctx.budgetLimitUsd,
        ctx,
        resumeAfterStepId: row.currentStep ?? undefined,
      };
    }

    const row = await prisma.aiWorkflowExecution.create({
      data: {
        workflowId: workflow.id,
        userId: options.userId,
        status: WorkflowStatus.RUNNING,
        inputData: inputData as object,
        executionTrace: [],
        totalTokensUsed: 0,
        totalCostUsd: 0,
        budgetLimitUsd: options.budgetLimitUsd ?? null,
        startedAt: new Date(),
      },
    });

    const ctx = createContext({
      executionId: row.id,
      workflowId: workflow.id,
      userId: options.userId,
      inputData,
      defaultErrorStrategy: workflow.definition.errorStrategy,
      budgetLimitUsd: options.budgetLimitUsd,
      signal: options.signal,
      logger: baseLogger.withContext({ executionId: row.id }),
    });

    return { executionId: row.id, trace: [], budgetLimitUsd: options.budgetLimitUsd, ctx };
  }

  /** Walk edges from a given step id without executing it (resume helper). */
  private nextIdsAfter(byId: Map<string, WorkflowStep>, afterId: string): string[] {
    const step = byId.get(afterId);
    if (!step) return [];
    return step.nextSteps.map((e) => e.targetStepId);
  }

  private async markCurrentStep(executionId: string, stepId: string): Promise<void> {
    try {
      await prisma.aiWorkflowExecution.update({
        where: { id: executionId },
        data: { currentStep: stepId },
      });
    } catch (err) {
      // Non-fatal.
      void err;
    }
  }

  private async checkpoint(
    executionId: string,
    ctx: ExecutionContext,
    trace: ExecutionTraceEntry[]
  ): Promise<void> {
    try {
      await prisma.aiWorkflowExecution.update({
        where: { id: executionId },
        data: {
          executionTrace: trace as unknown as object,
          totalTokensUsed: ctx.totalTokensUsed,
          totalCostUsd: ctx.totalCostUsd,
        },
      });
    } catch (err) {
      ctx.logger.warn('Checkpoint failed', {
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async pauseForApproval(
    executionId: string,
    ctx: ExecutionContext,
    trace: ExecutionTraceEntry[],
    stepId: string
  ): Promise<void> {
    try {
      await prisma.aiWorkflowExecution.update({
        where: { id: executionId },
        data: {
          status: WorkflowStatus.PAUSED_FOR_APPROVAL,
          currentStep: stepId,
          executionTrace: trace as unknown as object,
          totalTokensUsed: ctx.totalTokensUsed,
          totalCostUsd: ctx.totalCostUsd,
        },
      });
    } catch (err) {
      ctx.logger.error('pauseForApproval: DB update failed', err, { executionId });
    }
  }

  private async finalize(
    executionId: string,
    ctx: ExecutionContext,
    trace: ExecutionTraceEntry[],
    status: WorkflowStatus,
    errorMessage: string | null
  ): Promise<void> {
    try {
      await prisma.aiWorkflowExecution.update({
        where: { id: executionId },
        data: {
          status,
          executionTrace: trace as unknown as object,
          totalTokensUsed: ctx.totalTokensUsed,
          totalCostUsd: ctx.totalCostUsd,
          completedAt: new Date(),
          errorMessage,
          outputData:
            status === WorkflowStatus.COMPLETED ? (ctx.stepOutputs as object) : Prisma.DbNull,
        },
      });
    } catch (err) {
      ctx.logger.error('finalize: DB update failed', err, { executionId });
    }
  }
}

// ================================================================
// Helpers
// ================================================================

/** Sanitize an error for client-facing text. */
function sanitizeError(err: ExecutorError): string {
  // `executor_threw` wraps raw upstream errors (e.g. LLM provider failures)
  // whose messages may contain sensitive internals — return a generic message.
  if (err.code === 'executor_threw') {
    return `Step "${err.stepId}" failed unexpectedly`;
  }
  // All other codes are authored by us and safe to forward.
  return err.message;
}

function backoffDelayMs(attempt: number): number {
  return Math.min(500 * Math.pow(2, attempt), 5_000);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
