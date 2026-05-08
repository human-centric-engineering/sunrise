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
import {
  executionTraceEntrySchema,
  stepErrorConfigSchema,
  turnEntriesSchema,
} from '@/lib/validations/orchestration';
import {
  WorkflowStatus,
  type ExecutionEvent,
  type ExecutionTraceEntry,
  type LlmTelemetryEntry,
  type StepResult,
  type TurnEntry,
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
  claimLease,
  generateLeaseToken,
  leaseExpiry,
  startHeartbeat,
  type ClaimReason,
  type LeaseHandle,
} from '@/lib/orchestration/engine/lease';
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
import {
  SPAN_WORKFLOW_EXECUTE,
  SPAN_WORKFLOW_STEP,
  SUNRISE_EXECUTION_ID,
  SUNRISE_STEP_ID,
  SUNRISE_STEP_TYPE,
  SUNRISE_USER_ID,
  SUNRISE_WORKFLOW_ID,
  setSpanStatus,
  withSpan,
  withSpanGenerator,
  type Span,
} from '@/lib/orchestration/tracing';

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
  /**
   * Pinned `AiWorkflowVersion.id` — stamped onto `AiWorkflowExecution.versionId`
   * so the execution record references the exact snapshot it ran. Optional
   * to keep the engine usable in tests / synthetic flows; production callers
   * (admin routes, scheduler, webhook trigger, run_workflow capability)
   * always pass it.
   */
  versionId?: string;
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
    const { executionId, trace, budgetLimitUsd, ctx, resumeAfterStepId, lease } =
      await this.initRun(workflow, inputData, options, baseLogger);

    yield workflowStarted(executionId, workflow.id);
    emitHookEvent('workflow.started', {
      executionId,
      workflowId: workflow.id,
      userId: options.userId,
    });

    // Heartbeat extends the lease while a long single step (multi-minute LLM call,
    // slow external_call) is in flight, so the orphan sweep doesn't claim a healthy run.
    // `try/finally` ensures the timer is cleared on early termination — cancellation,
    // throw, or generator return — even if the consumer stops iterating.
    const stopHeartbeat = startHeartbeat(lease.executionId, lease.token);
    try {
      // `withSpanGenerator` activates the workflow.execute span as the OTEL
      // active context across yields. Nested workflow.step spans (sequential
      // and parallel) and any deeper helper-`withSpan` calls automatically
      // see workflow.execute as their parent in OTLP backends — one trace
      // per execution, end-to-end.
      yield* withSpanGenerator(
        SPAN_WORKFLOW_EXECUTE,
        {
          [SUNRISE_EXECUTION_ID]: executionId,
          [SUNRISE_WORKFLOW_ID]: workflow.id,
          [SUNRISE_USER_ID]: options.userId,
        },
        (workflowSpan) =>
          this.executeInner(
            workflowSpan,
            workflow,
            lease,
            trace,
            budgetLimitUsd,
            ctx,
            resumeAfterStepId,
            baseLogger,
            options
          ),
        { manualStatus: true }
      );
    } finally {
      stopHeartbeat();
    }
  }

  /**
   * Inner body of `execute()` — owns the DAG walk, finalize, and terminal
   * event yields. Lives behind `withSpanGenerator` so the workflow.execute
   * span is active OTEL context across every yield. Sets the span's status
   * directly via `setSpanStatus` (the helper opts out via `manualStatus`)
   * because the failed-but-no-throw path must map `failureReason` to error
   * status without relying on an uncaught throw.
   */
  private async *executeInner(
    workflowSpan: Span,
    workflow: ExecuteWorkflowArg,
    lease: LeaseHandle,
    trace: ExecutionTraceEntry[],
    budgetLimitUsd: number | undefined,
    ctx: ExecutionContext,
    resumeAfterStepId: string | undefined,
    baseLogger: Logger,
    options: ExecuteOptions
  ): AsyncGenerator<ExecutionEvent, void, unknown> {
    const { executionId } = lease;
    let workflowSpanError: unknown = undefined;
    // Hoisted so the `finally` block can read them when computing the
    // span's terminal status.
    let failed = false;
    let failureReason: string | null = null;

    try {
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

          // `withSpanGenerator` activates the workflow.step span as the
          // OTEL active context across yields, so nested helper-`withSpan`
          // calls inside `executeSingleStep` (LLM runner, agent-call turn,
          // capability dispatcher) become children of this step in OTLP
          // backends. `manualStatus: true` lets us map the step descriptor's
          // `failed` flag to span status without throwing.
          const singleResult = yield* this.runSingleStepWithSpan(
            step,
            ctx,
            trace,
            lease,
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
                const exhaustionReason =
                  typeof singleResult.output === 'object' &&
                  singleResult.output !== null &&
                  'reason' in singleResult.output
                    ? (singleResult.output as Record<string, unknown>).reason
                    : singleResult.output;
                const reasonStr =
                  typeof exhaustionReason === 'string'
                    ? exhaustionReason
                    : exhaustionReason !== undefined && exhaustionReason !== null
                      ? JSON.stringify(exhaustionReason)
                      : '';
                queue.push(fallbackEdge.targetStepId);
                attachRetryToTrace(trace, step.id, {
                  attempt: retryEdge.maxRetries! + 1,
                  maxRetries: retryEdge.maxRetries!,
                  reason: reasonStr,
                  targetStepId: fallbackEdge.targetStepId,
                  exhausted: true,
                });
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

            const retryReason = (() => {
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
            })();
            attachRetryToTrace(trace, step.id, {
              attempt: attempts + 1,
              maxRetries: retryEdge.maxRetries!,
              reason: retryReason,
              targetStepId: id,
            });
            yield stepRetry(step.id, id, attempts + 1, retryEdge.maxRetries!, retryReason);
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
          lease,
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
      //
      // `finalize` returns `false` when the lease is gone — the orphan sweep handed this
      // row to a new owner before we got here. In that case we MUST suppress the terminal
      // event yield + completion/failure hook; the new owner emits them. Letting both hosts
      // emit produces duplicate terminal events for the same execution, which is exactly
      // the orphan-handoff race the lease design exists to close.
      // --------------------------------------------------------------
      if (!failed) {
        const wrote = await this.finalize(lease, ctx, trace, WorkflowStatus.COMPLETED, null);
        if (wrote) {
          yield workflowCompleted(finalOutput, ctx.totalTokensUsed, ctx.totalCostUsd);
          emitHookEvent('workflow.completed', {
            executionId,
            workflowId: workflow.id,
            userId: options.userId,
            tokensUsed: ctx.totalTokensUsed,
            costUsd: ctx.totalCostUsd,
          });
        }
      } else {
        const wrote = await this.finalize(
          lease,
          ctx,
          trace,
          WorkflowStatus.FAILED,
          failureReason ?? 'Execution did not complete'
        );
        if (wrote) {
          emitHookEvent('workflow.failed', {
            executionId,
            workflowId: workflow.id,
            userId: options.userId,
            reason: failureReason ?? 'Execution did not complete',
          });
        }
      }
    } catch (err) {
      workflowSpanError = err;
      throw err;
    } finally {
      // `withSpanGenerator` opts out of auto-status via `manualStatus: true`
      // and handles `safeRecordException` + `safeEnd` itself on rethrow.
      // We map the failed-but-no-throw path (DAG walk set `failed = true`,
      // generator returned normally) to error status here.
      if (workflowSpanError !== undefined) {
        setSpanStatus(workflowSpan, {
          code: 'error',
          message: workflowSpanError instanceof Error ? workflowSpanError.message : 'error',
        });
      } else if (failed) {
        setSpanStatus(workflowSpan, {
          code: 'error',
          message: failureReason ?? 'workflow failed',
        });
      } else {
        setSpanStatus(workflowSpan, { code: 'ok' });
      }
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
    telemetryOut: LlmTelemetryEntry[],
    /**
     * Called BEFORE each retry attempt (i.e. after attempt 0 fails, before attempt 1 runs;
     * never before attempt 0). Lets callers reset per-attempt state — multi-turn checkpoint
     * accumulators in `executeSingleStep` use this to clear `currentStepTurns` so failed
     * attempts' turns don't leak into the next attempt's history.
     */
    onAttemptStart?: (attempt: number) => Promise<void>
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
        if (attempt > 0 && onAttemptStart) {
          // Reset per-attempt accumulators (e.g. multi-turn `currentStepTurns`)
          // so the next attempt starts fresh. Cost accumulators above persist
          // across attempts intentionally — they reflect billing reality.
          await onAttemptStart(attempt);
        }
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
   * Wrap `executeSingleStep` in the workflow.step span. Drives the inner
   * generator inside `tracer.withActiveContext(span, …)` per iteration so
   * AsyncLocalStorage propagates `span` as the active OTEL context — any
   * helper-`withSpan` calls during step execution (LLM runner, agent-call
   * turn, capability dispatcher) become children of this span in OTLP
   * backends. Maps `singleResult.failed` to span status without throwing.
   */
  private async *runSingleStepWithSpan(
    step: WorkflowStep,
    ctx: ExecutionContext,
    trace: ExecutionTraceEntry[],
    lease: LeaseHandle,
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
    return yield* withSpanGenerator(
      SPAN_WORKFLOW_STEP,
      {
        [SUNRISE_STEP_ID]: step.id,
        [SUNRISE_STEP_TYPE]: step.type,
        [SUNRISE_EXECUTION_ID]: lease.executionId,
      },
      (span) =>
        this.executeSingleStepWithStatus(span, step, ctx, trace, lease, budgetLimitUsd, baseLogger),
      { manualStatus: true }
    );
  }

  /**
   * `executeSingleStep` adapter that sets the workflow.step span's status
   * from the step descriptor before returning. Lives separately from
   * `executeSingleStep` so the latter remains tracing-agnostic.
   */
  private async *executeSingleStepWithStatus(
    span: Span,
    step: WorkflowStep,
    ctx: ExecutionContext,
    trace: ExecutionTraceEntry[],
    lease: LeaseHandle,
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
    const result = yield* this.executeSingleStep(
      step,
      ctx,
      trace,
      lease,
      budgetLimitUsd,
      baseLogger
    );
    if (result.failed) {
      setSpanStatus(span, {
        code: 'error',
        message: result.failureReason ?? 'step failed',
      });
    } else {
      setSpanStatus(span, { code: 'ok' });
    }
    return result;
  }

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
    lease: LeaseHandle,
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
    const { executionId } = lease;
    yield stepStarted(step.id, step.type, step.name);
    await this.markCurrentStep(lease, step.id, baseLogger);

    const started = Date.now();
    const telemetryOut: LlmTelemetryEntry[] = [];
    let stepResult: StepResult | null = null;
    let stepError: ExecutorError | null = null;

    // Multi-turn checkpoint plumbing. `stepTurns` is the in-memory accumulator
    // for this step; it seeds from `ctx.resumeTurns` (set by initRun on the
    // resume path) so a re-driven step picks up where it left off. The closure
    // bound to `ctx.recordTurn` mirrors the array to the row's
    // `currentStepTurns` column on each call. The accumulator is also captured
    // by reference into the per-attempt reset callback below, so retry attempts
    // start fresh — see `onAttemptStart`.
    //
    // `ctx.resumeTurns` STAYS on the live context across `runStepWithStrategy`
    // so attempt 0's snapshot (taken lazily inside `invokeExecutor`) carries
    // it through to the executor. We clear it after the call so subsequent
    // steps don't see stale resume state, and `onAttemptStart` clears it
    // between retry attempts so retries start fresh (no resume replay on
    // attempt 1+).
    const stepTurns: TurnEntry[] = [...(ctx.resumeTurns ?? [])];
    ctx.recordTurn = async (turn: TurnEntry) => {
      stepTurns.push(turn);
      await this.recordStepTurn(lease, stepTurns, baseLogger);
    };
    // Reset between retry attempts: failed attempts shouldn't accumulate into
    // the next attempt's turns. The dispatch cache prevents side-effect
    // duplication, but the turn history needs to reflect the SUCCESSFUL run
    // only; otherwise a crash AFTER retry would replay turns from the failed
    // attempt and corrupt the executor's reconstructed state.
    const onAttemptStart = async (): Promise<void> => {
      stepTurns.length = 0;
      ctx.resumeTurns = undefined; // resume replay is for attempt 0 only
      await this.recordStepTurn(lease, [], baseLogger);
    };

    try {
      stepResult = yield* this.runStepWithStrategy(step, ctx, telemetryOut, onAttemptStart);
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
          ...(stepTurns.length > 0 ? { turns: [...stepTurns] } : {}),
        });
        // The pause path's column DOES retain currentStepTurns on purpose:
        // pauseForApproval doesn't touch it, and the column is what
        // approval-resume's initRun reads to repopulate ctx.resumeTurns. The
        // trace entry's `turns` field is for observability; the column is for
        // resume.
        //
        // Clearing both context fields here prevents the next step's executor
        // — or, more dangerously, sibling code paths like `runStepToCompletion`
        // (parallel batches) — from inheriting a stale closure pointing at this
        // step's `stepTurns` array and lease. The contract is: `ctx.recordTurn`
        // is bound by `executeSingleStep` for the duration of one step only.
        ctx.resumeTurns = undefined;
        ctx.recordTurn = undefined;
        const approvalData =
          typeof err.payload === 'object' && err.payload !== null
            ? (err.payload as Record<string, unknown>)
            : undefined;
        const paused = await this.pauseForApproval(lease, ctx, trace, step.id, approvalData);
        if (paused) {
          yield approvalRequired(step.id, err.payload);
        }
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
        ...(stepTurns.length > 0 ? { turns: [...stepTurns] } : {}),
      });
      ctx.resumeTurns = undefined;
      ctx.recordTurn = undefined;
      await this.checkpoint(lease, ctx, trace);
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
      ...(stepTurns.length > 0 ? { turns: [...stepTurns] } : {}),
    });
    ctx.resumeTurns = undefined;
    ctx.recordTurn = undefined;
    await this.checkpoint(lease, ctx, trace);

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
    lease: LeaseHandle,
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
    const { executionId } = lease;
    const allEvents: ExecutionEvent[] = [];
    const allNextIds: string[] = [];
    let lastOutput: unknown = undefined;
    let batchFailed = false;
    let batchPaused = false;
    let batchFailureReason: string | undefined;

    // Mark all steps as current (best-effort).
    for (const step of steps) {
      void this.markCurrentStep(lease, step.id, baseLogger);
    }

    // Run all steps concurrently. Each step runs its full strategy
    // (including retries) independently.
    // Note: allEvents.push() from concurrent callbacks is safe because
    // Node.js is single-threaded — each push() completes atomically between awaits.
    const promises = steps.map(async (step) =>
      // `withSpan` activates the parallel-branch span as the OTEL active
      // context; AsyncLocalStorage forks per Promise (Node ≥ 18), so each
      // branch sees the outer workflow.execute as parent without entanglement
      // with sibling branches. `manualStatus: true` lets us set the span
      // status from the inner — necessary because the existing parallel-batch
      // contract requires errors to be collected into a descriptor for the
      // post-`Promise.allSettled` merge rather than rethrown.
      withSpan(
        SPAN_WORKFLOW_STEP,
        {
          [SUNRISE_STEP_ID]: step.id,
          [SUNRISE_STEP_TYPE]: step.type,
          [SUNRISE_EXECUTION_ID]: executionId,
        },
        async (span) => {
          const started = Date.now();
          // Per-step telemetry buffer — isolated from sibling parallel branches.
          const telemetryOut: LlmTelemetryEntry[] = [];
          allEvents.push(stepStarted(step.id, step.type, step.name));

          try {
            const result = await this.runStepToCompletion(step, ctx, telemetryOut);
            const durationMs = Date.now() - started;
            setSpanStatus(span, { code: 'ok' });
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
              // Pause is not a tracer-level error — workflow continues from the
              // pause point after admin approval.
              setSpanStatus(span, { code: 'ok' });
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
            setSpanStatus(span, { code: 'error', message: execErr.message });
            return { step, result: null, durationMs, started, telemetryOut, error: execErr };
          }
        },
        { manualStatus: true }
      )
    );

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
        const batchPausedOk = await this.pauseForApproval(
          lease,
          ctx,
          trace,
          step.id,
          batchApprovalData
        );
        if (batchPausedOk) {
          allEvents.push(approvalRequired(step.id, outcome.value.payload));
        }
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
        await this.checkpoint(lease, ctx, trace);
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
      await this.checkpoint(lease, ctx, trace);

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
    lease: LeaseHandle;
  }> {
    if (options.resumeFromExecutionId) {
      const row = await prisma.aiWorkflowExecution.findUnique({
        where: { id: options.resumeFromExecutionId },
      });
      if (!row) {
        throw new Error(`Execution row ${options.resumeFromExecutionId} not found`);
      }
      // Approval-resume vs. orphan-resume drives whether `recoveryAttempts` increments.
      // Approval pauses are clean state boundaries — no recovery cost. Orphan resume re-runs
      // the in-flight step so it counts against the cap that the orphan sweep enforces.
      const reason: ClaimReason =
        row.status === WorkflowStatus.RUNNING ? 'orphan-resume' : 'fresh-resume';
      const leaseToken = await claimLease(row.id, reason);
      if (!leaseToken) {
        throw new Error(`Execution ${row.id} is owned by another host (lease conflict on resume)`);
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
      // Multi-turn resume: if the in-flight step had recorded turns before the
      // crash, hand them to the executor via `ctx.resumeTurns` so it can replay
      // its in-memory state and continue from the next turn rather than
      // restart at turn 0. The dispatch cache (`ai_workflow_step_dispatch`)
      // makes the replay safe — already-completed tool calls return cached
      // results without re-firing.
      if (row.currentStep && row.currentStepTurns !== null) {
        const parsedTurns = turnEntriesSchema.safeParse(row.currentStepTurns);
        if (parsedTurns.success && parsedTurns.data.length > 0) {
          ctx.resumeTurns = parsedTurns.data;
          baseLogger.info('Resume: restoring multi-turn step state', {
            executionId: row.id,
            currentStep: row.currentStep,
            turns: parsedTurns.data.length,
          });
        } else if (!parsedTurns.success) {
          // Operators need to identify which field/shape regressed without
          // re-parsing the row by hand. Log the first three issue paths and
          // messages alongside the count so a schema drift is visible from
          // the log alone. Drops the malformed payload and falls through to
          // a fresh-start resume — the dispatch cache prevents side-effect
          // re-fire, but the executor's in-memory state restarts at turn 0.
          baseLogger.warn('Resume: dropped malformed currentStepTurns', {
            executionId: row.id,
            issues: parsedTurns.error.issues.length,
            sampleIssues: parsedTurns.error.issues.slice(0, 3).map((issue) => ({
              path: issue.path.join('.'),
              message: issue.message,
            })),
          });
        }
      }
      await prisma.aiWorkflowExecution.updateMany({
        where: { id: row.id, leaseToken },
        data: { status: WorkflowStatus.RUNNING, startedAt: row.startedAt ?? new Date() },
      });
      return {
        executionId: row.id,
        trace,
        budgetLimitUsd: ctx.budgetLimitUsd,
        ctx,
        resumeAfterStepId: row.currentStep ?? undefined,
        lease: { executionId: row.id, token: leaseToken },
      };
    }

    const leaseToken = generateLeaseToken();
    const now = new Date();
    const row = await prisma.aiWorkflowExecution.create({
      data: {
        workflowId: workflow.id,
        versionId: workflow.versionId ?? null,
        userId: options.userId,
        status: WorkflowStatus.RUNNING,
        inputData: inputData as object,
        executionTrace: [],
        totalTokensUsed: 0,
        totalCostUsd: 0,
        budgetLimitUsd: options.budgetLimitUsd ?? null,
        startedAt: now,
        leaseToken,
        leaseExpiresAt: leaseExpiry(now),
        lastHeartbeatAt: now,
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

    return {
      executionId: row.id,
      trace: [],
      budgetLimitUsd: options.budgetLimitUsd,
      ctx,
      lease: { executionId: row.id, token: leaseToken },
    };
  }

  /** Walk edges from a given step id without executing it (resume helper). */
  private nextIdsAfter(byId: Map<string, WorkflowStep>, afterId: string): string[] {
    const step = byId.get(afterId);
    if (!step) return [];
    return step.nextSteps.map((e) => e.targetStepId);
  }

  private async markCurrentStep(lease: LeaseHandle, stepId: string, logger: Logger): Promise<void> {
    const { executionId, token } = lease;
    try {
      // Lease-guarded: a stale-token holder's update silently no-ops via count=0.
      // Refresh the lease in the same UPDATE so step transitions also extend ownership.
      // currentStepTurns is reset to null because the column belongs to whichever step is
      // named in currentStep — clearing it on transition keeps the invariant. Resume already
      // copied the prior step's turns into `ctx.resumeTurns` before this UPDATE runs, so
      // clearing here doesn't lose data.
      await prisma.aiWorkflowExecution.updateMany({
        where: { id: executionId, leaseToken: token },
        data: {
          currentStep: stepId,
          currentStepTurns: Prisma.DbNull,
          leaseExpiresAt: leaseExpiry(),
          lastHeartbeatAt: new Date(),
        },
      });
    } catch (err) {
      // Non-fatal — but emit a warn so a connection-pool exhaustion or driver error doesn't
      // hide for minutes until the next checkpoint surfaces it.
      logger.warn('markCurrentStep: DB update failed (non-fatal)', {
        executionId,
        stepId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Persist the latest turn snapshot for the current step. Lease-guarded — a stale-token
   * holder's update silently no-ops via count=0. The lease is refreshed in the same UPDATE so
   * a multi-turn LLM step that runs longer than `HEARTBEAT_INTERVAL_MS` keeps ownership
   * without depending on the heartbeat timer.
   *
   * The full array is written each call (overwrite, not append). Postgres JSONB has no
   * native append op, and a read-modify-write JSONB merge would race with concurrent writers
   * — but at this scale there's only ever one host writing per execution (lease guarantees
   * exclusivity), so the simpler overwrite is correct and avoids the round-trip a merge
   * would require.
   *
   * Posture matches `markCurrentStep` and `checkpoint`: a DB hiccup mid-step is non-fatal —
   * the in-memory turns array is the source of truth for THIS attempt; the worst case is a
   * crashed re-drive starts from an earlier turn (and the dispatch cache prevents
   * side-effect duplication on the replay).
   *
   * Log-level branch on the clear-write case (`turns.length === 0`): the empty-array write is
   * fired by `executeSingleStep`'s `onAttemptStart` callback between retry attempts. If THAT
   * write fails AND the host then crashes before attempt N+1's first successful turn record,
   * a subsequent resume will replay attempt N's stale turns. The dispatch cache stops side-
   * effect duplication, but the executor's reconstructed in-memory state (orchestrator round
   * counter, agent_call message history, reflect draft) diverges from reality — token cost
   * for the dropped attempt's partial work is lost. Surface this as `error` (not `warn`) so
   * operators can monitor; behaviour is still non-fatal because a failed retry-clear is
   * marginally better than a failed retry attempt itself.
   */
  private async recordStepTurn(
    lease: LeaseHandle,
    turns: TurnEntry[],
    logger: Logger
  ): Promise<void> {
    const { executionId, token } = lease;
    const isClearWrite = turns.length === 0;
    try {
      await prisma.aiWorkflowExecution.updateMany({
        where: { id: executionId, leaseToken: token },
        data: {
          currentStepTurns: turns as unknown as object,
          leaseExpiresAt: leaseExpiry(),
          lastHeartbeatAt: new Date(),
        },
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      if (isClearWrite) {
        logger.error(
          'recordStepTurn: retry-clear write failed — next retry attempt may inherit stale turns on a subsequent crash; investigate DB connectivity',
          { executionId, error: errorMessage }
        );
      } else {
        logger.warn(
          'recordStepTurn: DB update failed (non-fatal — re-drive may restart at earlier turn)',
          { executionId, error: errorMessage }
        );
      }
    }
  }

  private async checkpoint(
    lease: LeaseHandle,
    ctx: ExecutionContext,
    trace: ExecutionTraceEntry[]
  ): Promise<void> {
    const { executionId, token } = lease;
    try {
      const result = await prisma.aiWorkflowExecution.updateMany({
        where: { id: executionId, leaseToken: token },
        data: {
          executionTrace: trace as unknown as object,
          totalTokensUsed: ctx.totalTokensUsed,
          totalCostUsd: ctx.totalCostUsd,
          leaseExpiresAt: leaseExpiry(),
          lastHeartbeatAt: new Date(),
        },
      });
      if (result.count === 0) {
        // Lease lost — another host has claimed this run. The orphan sweep handed it off
        // because our heartbeat lapsed. Future writes from this run will keep no-opping;
        // the new owner is the source of truth.
        ctx.logger.warn('Checkpoint: lease lost — another host owns this run', {
          executionId,
        });
      }
    } catch (err) {
      ctx.logger.error('Checkpoint failed — in-memory trace may diverge from DB', {
        executionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Apply the paused-state write atomically with the lease clear. Returns `true` when the
   * UPDATE landed (we owned the lease and the row tipped to PAUSED_FOR_APPROVAL) and `false`
   * when `updateMany` returned `count: 0` (orphan handoff) or the write threw. Callers MUST
   * honour the return value: yielding `approvalRequired` on a `false` return would surface a
   * second SSE event for a row another host is driving — same single-owner-event contract as
   * `finalize`.
   */
  private async pauseForApproval(
    lease: LeaseHandle,
    ctx: ExecutionContext,
    trace: ExecutionTraceEntry[],
    stepId: string,
    approvalPayload?: Record<string, unknown>
  ): Promise<boolean> {
    const { executionId, token } = lease;
    try {
      // Atomic terminal-state-and-lease-clear: the row stops being driven the moment its
      // status flips, so a separate clear UPDATE would leave a brief window where the
      // orphan sweep could mistake a paused row for a stuck-running one.
      const result = await prisma.aiWorkflowExecution.updateMany({
        where: { id: executionId, leaseToken: token },
        data: {
          status: WorkflowStatus.PAUSED_FOR_APPROVAL,
          currentStep: stepId,
          executionTrace: trace as unknown as object,
          totalTokensUsed: ctx.totalTokensUsed,
          totalCostUsd: ctx.totalCostUsd,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      if (result.count === 0) {
        // Lease lost — the orphan sweep handed this row to a new owner who is now the
        // source of truth. Suppress notification + hook + webhook + approvalRequired event
        // so we don't dispatch an approval card for a row another host is driving (which
        // would surface a confusing "approval no longer pending" error when the user clicks
        // the link).
        ctx.logger.warn('pauseForApproval: lease lost — suppressing notification + hook', {
          executionId,
          stepId,
        });
        return false;
      }
    } catch (err) {
      ctx.logger.error('pauseForApproval: DB update failed', err, { executionId });
      return false; // Don't emit events if DB update failed
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
    return true;
  }

  /**
   * Apply the terminal-state write atomically with the lease clear. Returns `true` when the
   * UPDATE landed (we owned the lease and the row tipped to its terminal state) and `false`
   * when `updateMany` returned `count: 0` — i.e. the orphan sweep handed this row to a new
   * owner before we got here. Callers MUST honour the return value: yielding the terminal
   * event or emitting the completion hook on a `false` return would produce duplicate
   * terminal events for the same execution (one from us, one from the new owner).
   */
  private async finalize(
    lease: LeaseHandle,
    ctx: ExecutionContext,
    trace: ExecutionTraceEntry[],
    status: WorkflowStatus,
    errorMessage: string | null
  ): Promise<boolean> {
    const { executionId, token } = lease;
    try {
      const result = await prisma.aiWorkflowExecution.updateMany({
        where: { id: executionId, leaseToken: token },
        data: {
          status,
          executionTrace: trace as unknown as object,
          totalTokensUsed: ctx.totalTokensUsed,
          totalCostUsd: ctx.totalCostUsd,
          completedAt: new Date(),
          errorMessage,
          outputData:
            status === WorkflowStatus.COMPLETED ? (ctx.stepOutputs as object) : Prisma.DbNull,
          leaseToken: null,
          leaseExpiresAt: null,
        },
      });
      if (result.count === 0) {
        ctx.logger.warn('finalize: lease lost before terminal write — another host owns this run', {
          executionId,
          status,
        });
        return false;
      }
      return true;
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

function attachRetryToTrace(
  trace: ExecutionTraceEntry[],
  stepId: string,
  retry: NonNullable<ExecutionTraceEntry['retries']>[number]
): void {
  for (let i = trace.length - 1; i >= 0; i--) {
    if (trace[i].stepId === stepId) {
      const existing = trace[i].retries ?? [];
      trace[i] = { ...trace[i], retries: [...existing, retry] };
      return;
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
