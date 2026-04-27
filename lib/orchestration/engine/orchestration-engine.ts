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
import { emitHookEvent } from '@/lib/orchestration/hooks/registry';

// Ensure every executor self-registers before the engine touches the
// registry. Importing for side effects.
import '@/lib/orchestration/engine/executors';

/** Default retry count for `retry` strategy. */
const DEFAULT_RETRY_COUNT = 2;

/** Budget-warning threshold (fraction of `budgetLimitUsd`). */
const BUDGET_WARN_FRACTION = 0.8;

/** Hard cap on steps walked in a single run — guards against pathological loops. */
const MAX_STEPS_PER_RUN = 1000;

/**
 * Callback-based subscriber for execution events.
 *
 * Use when you need push-based delivery rather than pull-based
 * (AsyncIterable) — e.g., forwarding events to WebSocket connections,
 * test harnesses, or in-process event buses.
 */
export type ExecutionSubscriber = (event: ExecutionEvent) => void;

export interface ExecuteOptions {
  userId: string;
  budgetLimitUsd?: number;
  signal?: AbortSignal;
  /**
   * Optional subscriber that receives every event in addition to the
   * AsyncIterable. Useful for tapping events without consuming the
   * iterator (e.g., progress logging, webhook dispatch).
   */
  subscriber?: ExecutionSubscriber;
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
    emitHookEvent('workflow.started', {
      executionId,
      workflowId: workflow.id,
      userId: options.userId,
    });

    // --------------------------------------------------------------
    // 2. DAG walk (supports parallel execution of sibling branches)
    // --------------------------------------------------------------
    const byId = new Map(workflow.definition.steps.map((s) => [s.id, s]));
    const visited = new Set<string>();
    const queue: string[] = resumeAfterStepId
      ? this.nextIdsAfter(byId, resumeAfterStepId)
      : [workflow.definition.entryStepId];

    // On resume, seed visited with steps already recorded in the trace
    // so the in-degree check doesn't block successors of completed steps.
    if (resumeAfterStepId) {
      for (const entry of trace) {
        visited.add(entry.stepId);
      }
    }

    // Build in-degree map for convergence detection. A step is "ready"
    // only when ALL its predecessors have been visited.
    const inDegree = new Map<string, Set<string>>();
    for (const step of workflow.definition.steps) {
      for (const edge of step.nextSteps) {
        if (!inDegree.has(edge.targetStepId)) {
          inDegree.set(edge.targetStepId, new Set());
        }
        inDegree.get(edge.targetStepId)!.add(step.id);
      }
    }

    const isReady = (stepId: string): boolean => {
      const preds = inDegree.get(stepId);
      if (!preds || preds.size === 0) return true;
      for (const pred of preds) {
        if (!visited.has(pred)) return false;
      }
      return true;
    };

    // Steps waiting for predecessors to complete before they can run.
    const pending = new Set<string>();

    let stepCount = 0;
    let finalOutput: unknown = null;
    let failed = false;
    let failureReason: string | null = null;

    while (queue.length > 0 || pending.size > 0) {
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

      // Promote any pending steps whose predecessors have all completed.
      for (const pid of pending) {
        if (isReady(pid)) {
          pending.delete(pid);
          queue.push(pid);
        }
      }

      if (queue.length === 0) {
        // All remaining steps are pending with unmet dependencies — deadlock.
        const pendingIds = [...pending].join(', ');
        failureReason = `Workflow deadlocked: steps [${pendingIds}] have unmet dependencies`;
        yield workflowFailed(failureReason);
        failed = true;
        break;
      }

      // Partition queue into ready and not-yet-ready steps (deduplicated).
      const readySet = new Set<string>();
      for (const id of queue) {
        if (visited.has(id) || readySet.has(id)) continue;
        if (isReady(id)) {
          readySet.add(id);
        } else {
          pending.add(id);
        }
      }
      queue.length = 0;
      const ready = [...readySet];

      if (ready.length === 0) continue;

      // ── Single step (sequential path — unchanged semantics) ──────
      if (ready.length === 1) {
        const stepId = ready[0];
        if (stepCount++ >= MAX_STEPS_PER_RUN) {
          failureReason = `Step count exceeded ${MAX_STEPS_PER_RUN}`;
          yield workflowFailed(failureReason);
          failed = true;
          break;
        }

        const step = byId.get(stepId);
        if (!step) {
          failureReason = `Unknown step id "${stepId}"`;
          yield workflowFailed(failureReason, stepId);
          failed = true;
          break;
        }
        visited.add(stepId);

        const singleResult = yield* this.executeSingleStep(
          step,
          ctx,
          trace,
          executionId,
          budgetLimitUsd,
          baseLogger
        );

        if (singleResult.paused) return;
        if (singleResult.failed) {
          failed = true;
          failureReason = singleResult.failureReason ?? null;
          break;
        }
        if (singleResult.output !== undefined) finalOutput = singleResult.output;
        if (singleResult.terminal) break;

        // Enqueue next steps.
        for (const id of singleResult.nextIds) {
          if (!visited.has(id)) queue.push(id);
        }
        continue;
      }

      // ── Parallel batch (multiple ready steps — run concurrently) ──
      // Validate batch size against step count cap.
      if (stepCount + ready.length > MAX_STEPS_PER_RUN) {
        failureReason = `Step count exceeded ${MAX_STEPS_PER_RUN}`;
        yield workflowFailed(failureReason);
        failed = true;
        break;
      }
      stepCount += ready.length;

      // Resolve all steps and mark visited before execution.
      const batchSteps: WorkflowStep[] = [];
      let batchValid = true;
      for (const stepId of ready) {
        const step = byId.get(stepId);
        if (!step) {
          failureReason = `Unknown step id "${stepId}"`;
          yield workflowFailed(failureReason, stepId);
          failed = true;
          batchValid = false;
          break;
        }
        batchSteps.push(step);
        visited.add(stepId);
      }
      if (!batchValid) break;

      // Execute all branch steps concurrently.
      const batchResult = await this.executeParallelBatch(
        batchSteps,
        ctx,
        trace,
        executionId,
        budgetLimitUsd,
        baseLogger
      );

      // Yield all collected events from the batch.
      for (const event of batchResult.events) {
        yield event;
      }

      if (batchResult.paused) return;
      if (batchResult.failed) {
        failed = true;
        failureReason = batchResult.failureReason ?? null;
        break;
      }
      if (batchResult.lastOutput !== undefined) finalOutput = batchResult.lastOutput;

      // Budget check after the batch.
      if (budgetLimitUsd && ctx.totalCostUsd > budgetLimitUsd) {
        failureReason = 'Budget exceeded';
        yield workflowFailed(failureReason);
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

      // Enqueue next steps from all completed branches.
      for (const id of batchResult.nextIds) {
        if (!visited.has(id)) queue.push(id);
      }
    }

    // --------------------------------------------------------------
    // 3. Terminal event
    // --------------------------------------------------------------
    if (!failed) {
      await this.finalize(executionId, ctx, trace, WorkflowStatus.COMPLETED, null);
      yield workflowCompleted(finalOutput, ctx.totalTokensUsed, ctx.totalCostUsd);
      emitHookEvent('workflow.completed', {
        executionId,
        workflowId: workflow.id,
        userId: options.userId,
        tokensUsed: ctx.totalTokensUsed,
        costUsd: ctx.totalCostUsd,
      });
    } else {
      await this.finalize(
        executionId,
        ctx,
        trace,
        WorkflowStatus.FAILED,
        failureReason ?? 'Execution did not complete'
      );
      emitHookEvent('workflow.failed', {
        executionId,
        workflowId: workflow.id,
        userId: options.userId,
        reason: failureReason ?? 'Execution did not complete',
      });
    }
  }

  /**
   * Execute with subscriber notification. Each yielded event is also
   * pushed to `options.subscriber` if present. This is the recommended
   * entry point when a callback-based consumer needs real-time events.
   */
  async *executeWithSubscriber(
    workflow: ExecuteWorkflowArg,
    inputData: Record<string, unknown>,
    options: ExecuteOptions
  ): AsyncIterable<ExecutionEvent> {
    const subscriber = options.subscriber;
    for await (const event of this.execute(workflow, inputData, options)) {
      if (subscriber) {
        try {
          subscriber(event);
        } catch {
          // Subscriber errors must never break the engine
        }
      }
      yield event;
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
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          executor(step, snapshotContext(ctx)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
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
      } finally {
        if (timer) clearTimeout(timer);
      }
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

  // ================================================================
  // Step execution helpers
  // ================================================================

  /**
   * Execute a single step with full lifecycle: start event, strategy
   * wrapping, trace, checkpoint, and completion/failure events.
   *
   * Returns a descriptor so the main loop can decide what to do next
   * without duplicating the post-step logic.
   */
  private async *executeSingleStep(
    step: WorkflowStep,
    ctx: ExecutionContext,
    trace: ExecutionTraceEntry[],
    executionId: string,
    budgetLimitUsd: number | undefined,
    baseLogger: Logger
  ): AsyncGenerator<
    ExecutionEvent,
    {
      failed: boolean;
      paused: boolean;
      terminal: boolean;
      failureReason?: string;
      output?: unknown;
      nextIds: string[];
    },
    unknown
  > {
    yield stepStarted(step.id, step.type, step.name);
    await this.markCurrentStep(executionId, step.id);

    const started = Date.now();
    let stepResult: StepResult | null = null;
    let stepError: ExecutorError | null = null;

    try {
      stepResult = yield* this.runStepWithStrategy(step, ctx);
    } catch (err) {
      if (err instanceof PausedForApproval) {
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
        return { failed: false, paused: true, terminal: true, nextIds: [] };
      }
      if (err instanceof BudgetExceeded) {
        yield workflowFailed('Budget exceeded', step.id);
        return {
          failed: true,
          paused: false,
          terminal: true,
          failureReason: 'Budget exceeded',
          nextIds: [],
        };
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
      const reason = sanitizeError(stepError);
      yield workflowFailed(reason, step.id);
      return { failed: true, paused: false, terminal: true, failureReason: reason, nextIds: [] };
    }

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

    // Budget check
    if (budgetLimitUsd && ctx.totalCostUsd > budgetLimitUsd) {
      yield workflowFailed('Budget exceeded', step.id);
      return {
        failed: true,
        paused: false,
        terminal: true,
        failureReason: 'Budget exceeded',
        nextIds: [],
      };
    }
    if (
      budgetLimitUsd &&
      ctx.totalCostUsd >= budgetLimitUsd * BUDGET_WARN_FRACTION &&
      !ctx.variables.__budgetWarned
    ) {
      ctx.variables.__budgetWarned = true;
      yield budgetWarning(ctx.totalCostUsd, budgetLimitUsd);
    }

    const nextIds =
      result.nextStepIds && result.nextStepIds.length > 0
        ? result.nextStepIds
        : step.nextSteps.map((edge) => edge.targetStepId);

    return {
      failed: false,
      paused: false,
      terminal: result.terminal ?? false,
      output: result.output,
      nextIds,
    };
  }

  /**
   * Execute multiple steps concurrently (parallel branches).
   *
   * Each step's executor runs via Promise.allSettled for true concurrency.
   * Results are merged into context **sequentially** after all settle to
   * avoid race conditions on `ctx.totalCostUsd` and `ctx.totalTokensUsed`.
   *
   * Events from all branches are collected and returned — the caller
   * yields them after this method returns.
   */
  private async executeParallelBatch(
    steps: WorkflowStep[],
    ctx: ExecutionContext,
    trace: ExecutionTraceEntry[],
    executionId: string,
    _budgetLimitUsd: number | undefined,
    baseLogger: Logger
  ): Promise<{
    events: ExecutionEvent[];
    failed: boolean;
    paused: boolean;
    failureReason?: string;
    lastOutput?: unknown;
    nextIds: string[];
  }> {
    const allEvents: ExecutionEvent[] = [];
    const allNextIds: string[] = [];
    let lastOutput: unknown = undefined;
    let batchFailed = false;
    let batchPaused = false;
    let batchFailureReason: string | undefined;

    // Mark all steps as current (best-effort).
    for (const step of steps) {
      void this.markCurrentStep(executionId, step.id);
    }

    // Run all steps concurrently. Each step runs its full strategy
    // (including retries) independently.
    // Note: allEvents.push() from concurrent callbacks is safe because
    // Node.js is single-threaded — each push() completes atomically between awaits.
    const promises = steps.map(async (step) => {
      const started = Date.now();
      allEvents.push(stepStarted(step.id, step.type, step.name));

      try {
        const result = await this.runStepToCompletion(step, ctx);
        const durationMs = Date.now() - started;
        return { step, result, durationMs, started, error: null as ExecutorError | null };
      } catch (err) {
        const durationMs = Date.now() - started;
        if (err instanceof PausedForApproval) {
          return {
            step,
            result: null,
            durationMs,
            started,
            paused: true,
            payload: err.payload,
            error: null,
          };
        }
        const execErr =
          err instanceof ExecutorError
            ? err
            : new ExecutorError(
                step.id,
                'executor_threw',
                err instanceof Error ? err.message : 'Executor threw an unknown error',
                err
              );
        return { step, result: null, durationMs, started, error: execErr };
      }
    });

    const settled = await Promise.allSettled(promises);

    // Process results sequentially to merge safely.
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        // Should not happen — inner function catches all errors.
        continue;
      }
      const { step, result, durationMs, started, error } = outcome.value;

      // Handle pause (rare in parallel — only if human_approval is in a branch)
      if ('paused' in outcome.value && outcome.value.paused) {
        trace.push({
          stepId: step.id,
          stepType: step.type,
          label: step.name,
          status: 'awaiting_approval',
          output: outcome.value.payload,
          tokensUsed: 0,
          costUsd: 0,
          startedAt: new Date(started).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs,
        });
        await this.pauseForApproval(executionId, ctx, trace, step.id);
        allEvents.push(approvalRequired(step.id, outcome.value.payload));
        batchPaused = true;
        continue;
      }

      if (error) {
        baseLogger.error('Workflow step failed (parallel)', error, {
          executionId,
          stepId: step.id,
          code: error.code,
        });
        trace.push({
          stepId: step.id,
          stepType: step.type,
          label: step.name,
          status: 'failed',
          output: null,
          error: sanitizeError(error),
          tokensUsed: 0,
          costUsd: 0,
          startedAt: new Date(started).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs,
        });
        await this.checkpoint(executionId, ctx, trace);
        allEvents.push(workflowFailed(sanitizeError(error), step.id));
        batchFailed = true;
        batchFailureReason = sanitizeError(error);
        continue;
      }

      // Success — merge result into context.
      const stepResult = result as StepResult;
      mergeStepResult(ctx, step.id, stepResult);
      trace.push({
        stepId: step.id,
        stepType: step.type,
        label: step.name,
        status: 'completed',
        output: stepResult.output,
        tokensUsed: stepResult.tokensUsed,
        costUsd: stepResult.costUsd,
        startedAt: new Date(started).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs,
      });
      await this.checkpoint(executionId, ctx, trace);

      allEvents.push(
        stepCompleted(
          step.id,
          stepResult.output,
          stepResult.tokensUsed,
          stepResult.costUsd,
          durationMs
        )
      );

      lastOutput = stepResult.output;

      const nextIds =
        stepResult.nextStepIds && stepResult.nextStepIds.length > 0
          ? stepResult.nextStepIds
          : step.nextSteps.map((edge) => edge.targetStepId);
      allNextIds.push(...nextIds);
    }

    return {
      events: allEvents,
      failed: batchFailed,
      paused: batchPaused,
      failureReason: batchFailureReason,
      lastOutput,
      nextIds: allNextIds,
    };
  }

  /**
   * Run a step through its error strategy to completion (non-generator).
   * Used by executeParallelBatch where we cannot yield from inside Promise.all.
   */
  private async runStepToCompletion(
    step: WorkflowStep,
    ctx: ExecutionContext
  ): Promise<StepResult> {
    const executor = getExecutor(step.type);
    const errorConfig = stepErrorConfigSchema.parse(step.config);
    const strategy = errorConfig.errorStrategy ?? ctx.defaultErrorStrategy ?? 'fail';
    const retryCount =
      typeof errorConfig.retryCount === 'number' ? errorConfig.retryCount : DEFAULT_RETRY_COUNT;
    const stepTimeoutMs = errorConfig.timeoutMs;

    const invokeExecutor = async (): Promise<StepResult> => {
      if (!stepTimeoutMs) {
        return executor(step, snapshotContext(ctx));
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          executor(step, snapshotContext(ctx)),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
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
      } finally {
        if (timer) clearTimeout(timer);
      }
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
          if (!lastError.retriable) throw lastError;
          if (attempt < retryCount) {
            await sleep(backoffDelayMs(attempt));
          }
        }
      }
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
        return { output: null, tokensUsed: 0, costUsd: 0 };
      }

      if (strategy === 'fallback') {
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

      // strategy === 'fail'
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
      ctx.logger.error('Checkpoint failed — in-memory trace may diverge from DB', {
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
      ctx.logger.error('finalize: DB update failed — execution row is stale', err, {
        executionId,
      });
      throw err;
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
