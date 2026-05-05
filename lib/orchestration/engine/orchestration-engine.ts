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
  type LlmTelemetryEntry,
  type StepResult,
  type WorkflowDefinition,
  type WorkflowStep,
} from '@/types/orchestration';
import { rollupTelemetry } from '@/lib/orchestration/trace/aggregate';
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
  stepRetry,
  stepStarted,
  workflowCompleted,
  workflowFailed,
  workflowStarted,
} from '@/lib/orchestration/engine/events';
import { getExecutor } from '@/lib/orchestration/engine/executor-registry';
import { emitHookEvent } from '@/lib/orchestration/hooks/registry';
import { dispatchWebhookEvent } from '@/lib/orchestration/webhooks/dispatcher';
import { buildApprovalUrls } from '@/lib/orchestration/approval-tokens';
import { dispatchApprovalNotification } from '@/lib/orchestration/notifications/dispatcher';
import { env } from '@/lib/env';

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
    // Bounded retry tracking: key = "sourceStepId→targetStepId", value = attempts used.
    const retryCount = new Map<string, number>();
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
    // Bounded retry back-edges (maxRetries > 0 + condition) are excluded —
    // they don't represent data dependencies and would cause deadlocks
    // after cascade-clear removes the back-edge source from visited.
    const inDegree = new Map<string, Set<string>>();
    for (const step of workflow.definition.steps) {
      for (const edge of step.nextSteps) {
        if (edge.maxRetries && edge.maxRetries > 0 && edge.condition) continue;
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

        // Enqueue next steps (with bounded retry support).
        for (const id of singleResult.nextIds) {
          if (!visited.has(id)) {
            queue.push(id);
            continue;
          }

          // The target was already visited — check if the originating edge
          // has a maxRetries cap that allows re-execution.
          const retryEdge = step.nextSteps.find(
            (e) => e.targetStepId === id && e.maxRetries && e.maxRetries > 0 && e.condition
          );
          if (!retryEdge) continue;

          const edgeKey = `${step.id}\u2192${id}`;
          const attempts = retryCount.get(edgeKey) ?? 0;
          if (attempts >= retryEdge.maxRetries!) {
            // Retry budget exhausted. If the source step has a sibling
            // edge with the same condition but no maxRetries, route
            // there as the exhaustion handler. Otherwise fall through
            // to the legacy silent-halt behaviour.
            const fallbackEdge = step.nextSteps.find(
              (e) =>
                e.targetStepId !== id &&
                e.condition?.toLowerCase() === retryEdge.condition?.toLowerCase() &&
                (!e.maxRetries || e.maxRetries === 0)
            );
            if (fallbackEdge && !visited.has(fallbackEdge.targetStepId)) {
              const failureReason =
                typeof singleResult.output === 'object' &&
                singleResult.output !== null &&
                'reason' in singleResult.output
                  ? (singleResult.output as Record<string, unknown>).reason
                  : singleResult.output;
              const reasonStr =
                typeof failureReason === 'string'
                  ? failureReason
                  : failureReason !== undefined && failureReason !== null
                    ? JSON.stringify(failureReason)
                    : '';
              queue.push(fallbackEdge.targetStepId);
              yield stepRetry(
                step.id,
                fallbackEdge.targetStepId,
                retryEdge.maxRetries! + 1,
                retryEdge.maxRetries!,
                reasonStr,
                true
              );
            }
            continue;
          }

          // Under the retry limit — re-queue the target.
          retryCount.set(edgeKey, attempts + 1);

          // Store retry context so the target step's prompt can reference
          // the failure reason via {{__retryContext.failureReason}}.
          ctx.variables.__retryContext = {
            fromStep: step.id,
            attempt: attempts + 1,
            maxRetries: retryEdge.maxRetries,
            failureReason:
              typeof singleResult.output === 'object' &&
              singleResult.output !== null &&
              'reason' in singleResult.output
                ? (singleResult.output as Record<string, unknown>).reason
                : String(singleResult.output),
          };

          // Cascade-clear visited for the retry target and all its
          // downstream dependents so the engine re-executes them.
          const toClear = new Set<string>([id]);
          const clearQueue = [id];
          while (clearQueue.length > 0) {
            const current = clearQueue.shift()!;
            const currentStep = byId.get(current);
            if (!currentStep) continue;
            for (const edge of currentStep.nextSteps) {
              if (visited.has(edge.targetStepId) && !toClear.has(edge.targetStepId)) {
                toClear.add(edge.targetStepId);
                clearQueue.push(edge.targetStepId);
              }
            }
          }
          for (const clearId of toClear) {
            visited.delete(clearId);
            pending.delete(clearId);
          }

          queue.push(id);

          yield stepRetry(
            step.id,
            id,
            attempts + 1,
            retryEdge.maxRetries!,
            (() => {
              if (
                typeof ctx.variables.__retryContext === 'object' &&
                ctx.variables.__retryContext !== null
              ) {
                const reason = (ctx.variables.__retryContext as Record<string, unknown>)
                  .failureReason;
                if (typeof reason === 'string') return reason;
                if (reason !== undefined && reason !== null) return JSON.stringify(reason);
              }
              return '';
            })()
          );
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
    ctx: ExecutionContext,
    telemetryOut: LlmTelemetryEntry[]
  ): AsyncGenerator<ExecutionEvent, StepResult, unknown> {
    const executor = getExecutor(step.type);
    const errorConfig = stepErrorConfigSchema.parse(step.config);
    const strategy = errorConfig.errorStrategy ?? ctx.defaultErrorStrategy ?? 'fail';
    const retryCount =
      typeof errorConfig.retryCount === 'number' ? errorConfig.retryCount : DEFAULT_RETRY_COUNT;
    const stepTimeoutMs = errorConfig.timeoutMs;

    // Wrap the executor call with an optional per-step timeout.
    // We DON'T reset telemetryOut between retry attempts: failed-attempt
    // turns were billed via AiCostLog, and the outer retry loop now also
    // accumulates their tokensUsed/costUsd into the StepResult (so the
    // header total matches the cost sub-table). Discarding telemetry on
    // retry would leave inputTokens/outputTokens reflecting only the
    // last attempt, mismatching the summed totals. Order is preserved
    // (failed turns come before the successful turn in time), so
    // rollupTelemetry's "last entry wins" still picks model/provider
    // from the successful attempt's last turn.
    const invokeExecutor = async (): Promise<StepResult> => {
      if (!stepTimeoutMs) {
        return executor(step, snapshotContext(ctx, telemetryOut));
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          executor(step, snapshotContext(ctx, telemetryOut)),
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
      // Failed attempts may have consumed tokens before throwing — see
      // ExecutorError's tokensUsed/costUsd. Roll the partials forward so
      // the eventual successful attempt's StepResult reflects everything
      // billed (and the fallthrough rethrow carries them on the error).
      // This mirrors the parallel-path accumulator in `runStepToCompletion`.
      let accumulatedTokens = 0;
      let accumulatedCost = 0;
      for (let attempt = 0; attempt <= retryCount; attempt++) {
        try {
          const result = await invokeExecutor();
          result.tokensUsed += accumulatedTokens;
          result.costUsd += accumulatedCost;
          return result;
        } catch (err) {
          // Pause / budget short-circuits: rethrow but carry the
          // accumulated partial so the engine's caught-handler in
          // executeSingleStep can record the cost from prior retriable
          // attempts (would otherwise be lost on the bare rethrow).
          if (err instanceof PausedForApproval) {
            if (accumulatedTokens === 0 && accumulatedCost === 0) throw err;
            throw new PausedForApproval(
              err.stepId,
              err.payload,
              err.tokensUsed + accumulatedTokens,
              err.costUsd + accumulatedCost
            );
          }
          if (err instanceof BudgetExceeded) {
            if (accumulatedTokens === 0 && accumulatedCost === 0) throw err;
            throw new BudgetExceeded(
              err.usedUsd,
              err.limitUsd,
              err.tokensUsed + accumulatedTokens,
              err.costUsd + accumulatedCost
            );
          }
          lastError =
            err instanceof ExecutorError
              ? err
              : new ExecutorError(
                  step.id,
                  'executor_threw',
                  err instanceof Error ? err.message : 'Executor threw an unknown error',
                  err
                );
          accumulatedTokens += lastError.tokensUsed;
          accumulatedCost += lastError.costUsd;
          // Don't retry non-retriable errors. Rethrow with the summed
          // partial cost so prior retriable attempts' billed tokens land
          // on the trace + ctx totals (otherwise we'd discard them when
          // we throw the bare lastError).
          if (!lastError.retriable) {
            throw new ExecutorError(
              lastError.stepId,
              lastError.code,
              lastError.message,
              lastError.cause,
              false,
              accumulatedTokens,
              accumulatedCost
            );
          }
          if (attempt < retryCount) {
            yield stepFailed(step.id, sanitizeError(lastError), true);
            await sleep(backoffDelayMs(attempt));
          }
        }
      }
      // Exhausted retries — rethrow the last error, carrying the summed
      // partial cost so executeSingleStep's catch can record the total.
      throw lastError
        ? new ExecutorError(
            lastError.stepId,
            lastError.code,
            lastError.message,
            lastError.cause,
            lastError.retriable,
            accumulatedTokens,
            accumulatedCost
          )
        : new ExecutorError(step.id, 'retry_exhausted', 'Retry exhausted');
    }

    try {
      return await invokeExecutor();
    } catch (err) {
      if (err instanceof PausedForApproval) throw err;
      if (err instanceof BudgetExceeded) throw err;
      const execErr =
        err instanceof ExecutorError
          ? err
          : new ExecutorError(
              step.id,
              'executor_threw',
              err instanceof Error ? err.message : 'Executor threw an unknown error',
              err
            );

      // Capture partial cost from the failed step so skip/fallback strategies
      // surface it instead of zeroing it out.
      const partialTokens = execErr.tokensUsed;
      const partialCost = execErr.costUsd;

      if (strategy === 'skip') {
        yield stepFailed(step.id, sanitizeError(execErr), false);
        return {
          output: null,
          tokensUsed: partialTokens,
          costUsd: partialCost,
          skipped: true,
        };
      }

      if (strategy === 'fallback') {
        yield stepFailed(step.id, sanitizeError(execErr), false);
        if (errorConfig.fallbackStepId) {
          return {
            output: null,
            tokensUsed: partialTokens,
            costUsd: partialCost,
            nextStepIds: [errorConfig.fallbackStepId],
          };
        }
        return { output: null, tokensUsed: partialTokens, costUsd: partialCost };
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
    const telemetryOut: LlmTelemetryEntry[] = [];
    let stepResult: StepResult | null = null;
    let stepError: ExecutorError | null = null;

    try {
      stepResult = yield* this.runStepWithStrategy(step, ctx, telemetryOut);
    } catch (err) {
      if (err instanceof PausedForApproval) {
        const durationMs = Date.now() - started;
        // Surface any partial cost from prior retry attempts (the retry
        // loop wraps the original PausedForApproval with the accumulator).
        // Default 0 for the common case (human_approval pauses with no
        // prior LLM work).
        ctx.totalTokensUsed += err.tokensUsed;
        ctx.totalCostUsd += err.costUsd;
        trace.push({
          stepId: step.id,
          stepType: step.type,
          label: step.name,
          status: 'awaiting_approval',
          output: err.payload,
          tokensUsed: err.tokensUsed,
          costUsd: err.costUsd,
          startedAt: new Date(started).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs,
          input: step.config,
          ...rollupTelemetry(telemetryOut),
        });
        const approvalData =
          typeof err.payload === 'object' && err.payload !== null
            ? (err.payload as Record<string, unknown>)
            : undefined;
        await this.pauseForApproval(executionId, ctx, trace, step.id, approvalData);
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
      // Capture partial cost from the failed executor so it's not lost.
      const failedTokens = stepError.tokensUsed;
      const failedCost = stepError.costUsd;
      ctx.totalTokensUsed += failedTokens;
      ctx.totalCostUsd += failedCost;
      trace.push({
        stepId: step.id,
        stepType: step.type,
        label: step.name,
        status: 'failed',
        output: null,
        error: sanitizeError(stepError),
        tokensUsed: failedTokens,
        costUsd: failedCost,
        startedAt: new Date(started).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs,
        input: step.config,
        ...rollupTelemetry(telemetryOut),
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
      status: result.skipped ? 'skipped' : 'completed',
      output: result.output,
      tokensUsed: result.tokensUsed,
      costUsd: result.costUsd,
      startedAt: new Date(started).toISOString(),
      completedAt: new Date().toISOString(),
      durationMs,
      input: step.config,
      ...rollupTelemetry(telemetryOut),
    });
    await this.checkpoint(executionId, ctx, trace);

    // Budget check — runs BEFORE step_completed so the event stream's
    // causality is honest. If this step's cost pushes the run over budget,
    // the workflow_failed event is the terminal event for this step; we do
    // not yield step_completed because the workflow failed at this step.
    // The trace entry above still records the cost so observability stays
    // intact.
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

    // Skip the step_completed event for skipped steps — runStepWithStrategy
    // already yielded step_failed { willRetry: false } when the strategy
    // resolved to 'skip', and emitting both events for the same step is
    // contradictory. Matches executeParallelBatch which only emits one
    // event per skipped step. The trace entry's status: 'skipped' remains
    // the canonical record.
    if (!result.skipped) {
      yield stepCompleted(step.id, result.output, result.tokensUsed, result.costUsd, durationMs);
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
   * **Budget note:** all branches run concurrently and complete before
   * results are merged. Budget is checked after merging each branch's
   * cost — if exceeded, remaining branch results are skipped and the
   * batch is marked as failed.
   *
   * Events from all branches are collected and returned — the caller
   * yields them after this method returns.
   */
  private async executeParallelBatch(
    steps: WorkflowStep[],
    ctx: ExecutionContext,
    trace: ExecutionTraceEntry[],
    executionId: string,
    budgetLimitUsd: number | undefined,
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
      // Per-step telemetry buffer — isolated from sibling parallel branches.
      const telemetryOut: LlmTelemetryEntry[] = [];
      allEvents.push(stepStarted(step.id, step.type, step.name));

      try {
        const result = await this.runStepToCompletion(step, ctx, telemetryOut);
        const durationMs = Date.now() - started;
        return {
          step,
          result,
          durationMs,
          started,
          telemetryOut,
          error: null as ExecutorError | null,
        };
      } catch (err) {
        const durationMs = Date.now() - started;
        if (err instanceof PausedForApproval) {
          return {
            step,
            result: null,
            durationMs,
            started,
            telemetryOut,
            paused: true,
            payload: err.payload,
            // Carry partial cost (set by the retry loop's accumulator-aware
            // PausedForApproval rethrow) so the trace entry below records it.
            tokensUsed: err.tokensUsed,
            costUsd: err.costUsd,
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
        return { step, result: null, durationMs, started, telemetryOut, error: execErr };
      }
    });

    const settled = await Promise.allSettled(promises);

    // Process results sequentially to merge safely.
    for (const outcome of settled) {
      if (outcome.status === 'rejected') {
        // Should not happen — inner function catches all errors.
        continue;
      }
      const { step, result, durationMs, started, telemetryOut, error } = outcome.value;

      // Handle pause (rare in parallel — only if human_approval is in a branch)
      if ('paused' in outcome.value && outcome.value.paused) {
        const pausedTokens = (outcome.value as { tokensUsed?: number }).tokensUsed ?? 0;
        const pausedCost = (outcome.value as { costUsd?: number }).costUsd ?? 0;
        ctx.totalTokensUsed += pausedTokens;
        ctx.totalCostUsd += pausedCost;
        trace.push({
          stepId: step.id,
          stepType: step.type,
          label: step.name,
          status: 'awaiting_approval',
          output: outcome.value.payload,
          tokensUsed: pausedTokens,
          costUsd: pausedCost,
          startedAt: new Date(started).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs,
          input: step.config,
          ...rollupTelemetry(telemetryOut),
        });
        const batchApprovalData =
          typeof outcome.value.payload === 'object' && outcome.value.payload !== null
            ? (outcome.value.payload as Record<string, unknown>)
            : undefined;
        await this.pauseForApproval(executionId, ctx, trace, step.id, batchApprovalData);
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
        // Capture partial cost from failed parallel branch.
        const failedTokens = error.tokensUsed;
        const failedCost = error.costUsd;
        ctx.totalTokensUsed += failedTokens;
        ctx.totalCostUsd += failedCost;
        trace.push({
          stepId: step.id,
          stepType: step.type,
          label: step.name,
          status: 'failed',
          output: null,
          error: sanitizeError(error),
          tokensUsed: failedTokens,
          costUsd: failedCost,
          startedAt: new Date(started).toISOString(),
          completedAt: new Date().toISOString(),
          durationMs,
          input: step.config,
          ...rollupTelemetry(telemetryOut),
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
        status: stepResult.skipped ? 'skipped' : 'completed',
        output: stepResult.output,
        tokensUsed: stepResult.tokensUsed,
        costUsd: stepResult.costUsd,
        startedAt: new Date(started).toISOString(),
        completedAt: new Date().toISOString(),
        durationMs,
        input: step.config,
        ...rollupTelemetry(telemetryOut),
      });
      await this.checkpoint(executionId, ctx, trace);

      if (stepResult.skipped) {
        allEvents.push(stepFailed(step.id, stepResult.skipError ?? 'Step skipped', false));
      } else {
        allEvents.push(
          stepCompleted(
            step.id,
            stepResult.output,
            stepResult.tokensUsed,
            stepResult.costUsd,
            durationMs
          )
        );
      }

      lastOutput = stepResult.output;

      const nextIds =
        stepResult.nextStepIds && stepResult.nextStepIds.length > 0
          ? stepResult.nextStepIds
          : step.nextSteps.map((edge) => edge.targetStepId);
      allNextIds.push(...nextIds);

      // Budget check after merging branch cost.
      if (budgetLimitUsd && ctx.totalCostUsd > budgetLimitUsd) {
        allEvents.push(workflowFailed('Budget exceeded during parallel batch', step.id));
        batchFailed = true;
        batchFailureReason = 'Budget exceeded during parallel batch';
        break;
      }
    }

    return {
      events: allEvents,
      failed: batchFailed,
      paused: batchPaused,
      failureReason: batchFailureReason,
      lastOutput,
      nextIds: [...new Set(allNextIds)],
    };
  }

  /**
   * Run a step through its error strategy to completion (non-generator).
   * Used by executeParallelBatch where we cannot yield from inside Promise.all.
   */
  private async runStepToCompletion(
    step: WorkflowStep,
    ctx: ExecutionContext,
    telemetryOut: LlmTelemetryEntry[]
  ): Promise<StepResult> {
    const executor = getExecutor(step.type);
    const errorConfig = stepErrorConfigSchema.parse(step.config);
    const strategy = errorConfig.errorStrategy ?? ctx.defaultErrorStrategy ?? 'fail';
    const retryCount =
      typeof errorConfig.retryCount === 'number' ? errorConfig.retryCount : DEFAULT_RETRY_COUNT;
    const stepTimeoutMs = errorConfig.timeoutMs;

    // Same telemetry-accumulation rule as runStepWithStrategy: do NOT reset
    // telemetryOut between attempts so summed inputTokens/outputTokens
    // align with the summed tokensUsed/costUsd the retry loop produces.
    const invokeExecutor = async (): Promise<StepResult> => {
      if (!stepTimeoutMs) {
        return executor(step, snapshotContext(ctx, telemetryOut));
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          executor(step, snapshotContext(ctx, telemetryOut)),
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
      // Accumulate partial cost from failed attempts so retries don't lose tokens.
      let accumulatedTokens = 0;
      let accumulatedCost = 0;
      for (let attempt = 0; attempt <= retryCount; attempt++) {
        try {
          const result = await invokeExecutor();
          // Include cost from prior failed attempts in the final result.
          result.tokensUsed += accumulatedTokens;
          result.costUsd += accumulatedCost;
          return result;
        } catch (err) {
          // Pause short-circuit: carry the retry accumulator through so
          // prior attempts' billed tokens reach the trace entry.
          if (err instanceof PausedForApproval) {
            if (accumulatedTokens === 0 && accumulatedCost === 0) throw err;
            throw new PausedForApproval(
              err.stepId,
              err.payload,
              err.tokensUsed + accumulatedTokens,
              err.costUsd + accumulatedCost
            );
          }
          // (Parallel retry doesn't catch BudgetExceeded — engine throws
          // it from outside the executor — so no symmetric path here.)
          lastError =
            err instanceof ExecutorError
              ? err
              : new ExecutorError(
                  step.id,
                  'executor_threw',
                  err instanceof Error ? err.message : 'Executor threw an unknown error',
                  err
                );
          accumulatedTokens += lastError.tokensUsed;
          accumulatedCost += lastError.costUsd;
          // Mirror runStepWithStrategy: rethrow non-retriable with the
          // accumulator so prior retriable attempts' billed tokens aren't
          // dropped from the trace.
          if (!lastError.retriable) {
            throw new ExecutorError(
              lastError.stepId,
              lastError.code,
              lastError.message,
              lastError.cause,
              false,
              accumulatedTokens,
              accumulatedCost
            );
          }
          if (attempt < retryCount) {
            await sleep(backoffDelayMs(attempt));
          }
        }
      }
      throw lastError
        ? new ExecutorError(
            lastError.stepId,
            lastError.code,
            lastError.message,
            lastError.cause,
            lastError.retriable,
            accumulatedTokens,
            accumulatedCost
          )
        : new ExecutorError(step.id, 'retry_exhausted', 'Retry exhausted');
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

      // Capture partial cost from the failed step for skip/fallback strategies.
      const partialTokens = execErr.tokensUsed;
      const partialCost = execErr.costUsd;

      if (strategy === 'skip') {
        return {
          output: null,
          tokensUsed: partialTokens,
          costUsd: partialCost,
          skipped: true,
          skipError: sanitizeError(execErr),
        };
      }

      if (strategy === 'fallback') {
        if (errorConfig.fallbackStepId) {
          return {
            output: null,
            tokensUsed: partialTokens,
            costUsd: partialCost,
            nextStepIds: [errorConfig.fallbackStepId],
          };
        }
        return { output: null, tokensUsed: partialTokens, costUsd: partialCost };
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
      if (Array.isArray(rawTrace) && trace.length < rawTrace.length) {
        baseLogger.warn('Resume: dropped corrupted trace entries', {
          executionId: row.id,
          totalEntries: rawTrace.length,
          validEntries: trace.length,
        });
      }
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
        if (entry.status === 'completed' || entry.status === 'skipped') {
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
    stepId: string,
    approvalPayload?: Record<string, unknown>
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
      return; // Don't emit events if DB update failed
    }

    const rawTimeout = approvalPayload?.timeoutMinutes;
    const timeoutMinutes = typeof rawTimeout === 'number' ? rawTimeout : undefined;
    const { approveUrl, rejectUrl, expiresAt } = buildApprovalUrls(
      executionId,
      env.BETTER_AUTH_URL,
      timeoutMinutes
    );

    const tokenExpiresAt = expiresAt.toISOString();

    const channel = dispatchApprovalNotification({
      executionId,
      workflowId: ctx.workflowId,
      stepId,
      prompt: approvalPayload?.prompt,
      notificationChannel: approvalPayload?.notificationChannel,
      approveUrl,
      rejectUrl,
      tokenExpiresAt,
    });

    const eventData = {
      executionId,
      workflowId: ctx.workflowId,
      userId: ctx.userId,
      stepId,
      prompt: approvalPayload?.prompt,
      notificationChannel: channel ?? approvalPayload?.notificationChannel,
      timeoutMinutes,
      approverUserIds: approvalPayload?.approverUserIds,
      approveUrl,
      rejectUrl,
      tokenExpiresAt,
    };

    emitHookEvent('workflow.paused_for_approval', eventData);
    void dispatchWebhookEvent('approval_required', eventData);
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
