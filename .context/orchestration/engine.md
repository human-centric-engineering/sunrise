# Orchestration engine

Runtime executor for validated `WorkflowDefinition`s. Lives in `lib/orchestration/engine/` and is consumed by `POST /api/v1/admin/orchestration/workflows/:id/execute` via the [`sseResponse`](../api/sse.md) helper. Platform-agnostic: no `next/*`, no `app/*`, no `NextRequest` — the engine never knows it is being served over HTTP.

## Quick start

```typescript
import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import { sseResponse } from '@/lib/api/sse';

const engine = new OrchestrationEngine();
const events = engine.execute(
  { id: workflow.id, definition: workflow.workflowDefinition },
  { query: 'hello' },
  {
    userId: session.user.id,
    budgetLimitUsd: 0.5,
    signal: request.signal,
    resumeFromExecutionId, // optional — resume a paused run
  }
);

return sseResponse(events, { signal: request.signal });
```

`execute()` returns `AsyncIterable<ExecutionEvent>`. Consumers iterate with `for await`; the SSE route hands the iterable straight to `sseResponse` which frames each event as `event: <type>\ndata: <json>\n\n`.

A second entry point, `executeWithSubscriber()`, wraps the same generator but calls a subscriber callback on each event before yielding. The `GET /workflows/:id/execute-stream` SSE route uses this variant to persist execution trace entries as events arrive.

## Module layout

```
lib/orchestration/engine/
├── orchestration-engine.ts    # the class + execute() generator
├── executor-registry.ts       # BE-only registry (no UI deps)
├── context.ts                 # ExecutionContext + createContext + mergeStepResult
├── events.ts                  # ExecutionEvent factory helpers
├── errors.ts                  # ExecutorError (+ retriable flag + partial cost), PausedForApproval, BudgetExceeded
├── execution-reaper.ts        # zombie reaper — marks stale RUNNING/PENDING/PAUSED rows as FAILED
├── step-registry.ts           # FE palette metadata: labels, colours, handle counts, defaultConfig
├── outbound-rate-limiter.ts   # per-host sliding-window rate limiter for external calls
├── llm-runner.ts              # shared LLM invocation + template interpolation
└── executors/
    ├── index.ts               # barrel — importing triggers all registrations
    ├── llm-call.ts
    ├── tool-call.ts
    ├── chain.ts
    ├── route.ts
    ├── parallel.ts
    ├── reflect.ts
    ├── plan.ts
    ├── human-approval.ts
    ├── rag-retrieve.ts
    ├── guard.ts
    ├── evaluate.ts
    ├── external-call.ts
    ├── agent-call.ts
    ├── notification.ts
    └── orchestrator.ts
```

Everything under `lib/orchestration/engine/` uses `@/…` imports and reads `prisma` from `@/lib/db/client`; nothing reaches for `next/*` or React. That makes the engine unit-testable without spinning up a server.

## Lifecycle

1. `execute()` is called with a validated `WorkflowDefinition`, `inputData`, and `{ userId, budgetLimitUsd?, signal?, resumeFromExecutionId? }`.
2. The engine creates (or loads, on resume) an `AiWorkflowExecution` row with `status: 'running'` and yields `workflow_started`.
3. Starting from `entryStepId`, the engine walks the DAG, executing steps sequentially except when a `parallel` fan-out produces multiple ready branches, which are executed concurrently via `Promise.allSettled`. Convergence points (steps with multiple incoming edges) wait for all predecessors to complete before executing.
   - Emit `step_started`.
   - Fetch the executor from the registry, wrap it in the step's `errorStrategy`.
   - Merge the result into `ExecutionContext`, append a structured `ExecutionTraceEntry`, **checkpoint** by updating the row's `executionTrace`, `totalTokensUsed`, `totalCostUsd`, and `currentStep`.
   - Emit `step_completed`.
   - Budget check: emit `budget_warning` at 80%, `workflow_failed` on overrun.
4. A terminal event (`workflow_completed` / `workflow_failed`) flips the row's final status and sets `completedAt`.

If the process dies mid-run, the row reflects the **last completed checkpoint**. Mid-run resume of LLM failures is not yet implemented — the one resume path that is implemented is `human_approval`, handled by the approve route at `app/api/v1/admin/orchestration/executions/[id]/approve/route.ts`.

**Resume rehydration.** When resuming, `initRun()` rebuilds `ctx.stepOutputs` from the persisted trace. Both `completed` and `skipped` entries are rehydrated — skipped steps contribute `null` to `stepOutputs` so downstream template interpolation finds `null` (not `undefined`) for skipped predecessors.

## Parallel Execution

When a `parallel` node completes, its `nextSteps` targets are all pushed to the ready queue. The engine detects multiple ready steps (those whose predecessors have all been visited) and runs them concurrently:

1. **In-degree map** — built at DAG walk start from `step.nextSteps` edges. Maps each step to its set of predecessor step IDs.
2. **Readiness check** — a step is "ready" when all its predecessors are in the `visited` set.
3. **Batch detection** — if multiple steps are ready simultaneously, they form a parallel batch.
4. **Concurrent execution** — batch steps run via `Promise.allSettled`, each receiving a frozen snapshot of the current context.
5. **Sequential merge** — after all settle, results are merged into context one-by-one to avoid race conditions on `totalCostUsd` and `totalTokensUsed`.
6. **Convergence** — a join step (with in-degree > 1) stays in the `pending` set until all its predecessors complete, then becomes ready on the next iteration.

The `stragglerStrategy: 'wait-all'` config on parallel nodes is the implemented mode. `first-success` is not yet supported.

**Parallel skip events.** When a parallel branch fails and the step's error strategy is `skip`, the engine emits a `step_failed` SSE event (with `willRetry: false`) so SSE clients learn about the failure immediately — without this, the client wouldn't see the failure until trace reconciliation. The `skipError` field on `StepResult` carries the sanitised error message for the event payload.

## Bounded retry loops

Edges in `ConditionalEdge` can carry `maxRetries?: number` (1–10, schema-enforced). When a step (typically a `guard`) emits a conditional edge whose target has already been visited, the engine treats it as a **bounded retry back-edge** instead of skipping the already-visited target:

1. **Retry tracking** — `retryCount: Map<string, number>` keyed by `"sourceId→targetId"`. Each back-edge traversal increments the counter.
2. **Under limit** — the target and all its downstream steps are removed from `visited` and `pending` (cascade-clear via BFS over the adjacency list). The target is re-queued and re-executes with fresh context.
3. **At limit** — the engine looks for a sibling edge from the same source step with the same `condition` but no `maxRetries`. If one exists, it enqueues that target as the **exhaustion handler**. If not, the back-edge is skipped silently and the engine continues to the next edge or stops if none remain. This lets a workflow surface a retry-budget-spent failure to a notification or alert step rather than terminating in the middle of the graph. See the audit template (`prisma/seeds/data/templates/provider-model-audit.ts`) for an example: `validate_proposals` carries both a `maxRetries: 2` fail-edge to `audit_models` and a no-`maxRetries` fail-edge to `report_validation_failure`.
4. **Failure context** — before re-queuing, the engine stores `ctx.variables.__retryContext`:
   ```typescript
   {
     fromStep: 'guard_step_id',
     attempt: 2,           // 1-indexed
     maxRetries: 3,
     failureReason: '...'  // guard's failure output
   }
   ```
   The retry target can reference these via the template's `vars.` prefix:
   ```
   {{#if vars.__retryContext}}
   Previous attempt failed validation: {{vars.__retryContext.failureReason}}
   (attempt {{vars.__retryContext.attempt}} of {{vars.__retryContext.maxRetries}}).
   Re-evaluate and produce corrected output.
   {{/if}}
   ```
   The interpolator (`lib/orchestration/engine/llm-runner.ts`) supports `{{vars.<dotted.path>}}` for any context variable plus flat `{{#if vars.<path>}}body{{/if}}` conditional blocks. Earlier versions referenced `__retryContext` without the `vars.` prefix; that syntax was never wired to anything and silently expanded to empty.
5. **Observability** — a `step_retry` event is emitted for each retry, distinct from `step_started`, so the execution trace shows retry attempts clearly. The exhaustion-handler routing (step 3) emits its own `step_retry` event with `attempt = maxRetries + 1` and `exhausted: true`, with `targetStepId` pointing at the fallback edge target — trace consumers can render this as a distinct "retry budget exhausted" sub-row. The engine also attaches each retry record to the source step's most recent `ExecutionTraceEntry` under an optional `retries[]` array, so the persisted trace shows where loops happened without replaying the SSE stream.

**Safety:** each retry iteration counts against `MAX_STEPS_PER_RUN = 1000`. Combined with the per-edge `maxRetries` cap of 10, runaway loops are doubly bounded.

**Cascade-clear:** when a retry target is re-queued, all steps reachable from that target are also cleared from `visited`. This ensures downstream steps re-execute with the retry target's fresh output rather than stale results from the previous attempt.

## `ExecutionEvent` (SSE payloads)

Defined in `types/orchestration.ts`. Discriminated union — every client switches on `event.type`:

| `type`                     | Key fields                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workflow_started`         | `executionId`, `workflowId`                                                                                                                                                                                                                                                                                                                                              |
| `step_started`             | `stepId`, `stepType`, `label`                                                                                                                                                                                                                                                                                                                                            |
| `step_completed`           | `stepId`, `output`, `tokensUsed`, `costUsd`, `durationMs`                                                                                                                                                                                                                                                                                                                |
| `step_retry`               | `fromStepId`, `targetStepId`, `attempt`, `maxRetries`, `reason`, optional `exhausted: true` when routed to a fallback edge after retries were spent                                                                                                                                                                                                                      |
| `step_failed`              | `stepId`, `error`, `willRetry`                                                                                                                                                                                                                                                                                                                                           |
| `approval_required`        | `stepId`, `payload` (shape: `{ prompt, previous, ... }`)                                                                                                                                                                                                                                                                                                                 |
| `budget_warning`           | `usedUsd`, `limitUsd`                                                                                                                                                                                                                                                                                                                                                    |
| `workflow_budget_exceeded` | `usedUsd`, `limitUsd`, `failedStepId` — fires immediately BEFORE `workflow_failed` on per-execution cap breach (improvement #39). Dispatches the `workflow_budget_exceeded` webhook fire-and-forget so subscribers can branch on the cap-breach case without string-matching `workflow_failed.error`. The generic `workflow_failed` still follows as the terminal event. |
| `workflow_completed`       | `output`, `totalTokensUsed`, `totalCostUsd`                                                                                                                                                                                                                                                                                                                              |
| `workflow_failed`          | `error`, `failedStepId?` — error string is `"Budget exceeded ($X.XXXX / $Y.YYYY cap)"` on a cap breach (stable prefix for executions-list / live-engine styling)                                                                                                                                                                                                         |

The parallel `ExecutionTraceEntry` (also in `types/orchestration.ts`) is what the engine persists to `AiWorkflowExecution.executionTrace` — one per completed step, with `stepId`, `stepType`, `label`, `status`, `output`, `tokensUsed`, `costUsd`, `startedAt`, `completedAt`, and `durationMs`. **Per-branch `completedAt` capture (parallel batch).** Inside `executeParallelBatch`, each branch's `endedAt` is recorded inside its own `Promise.allSettled` callback the instant the branch finishes — not in the post-settle sequential merge loop. The post-settle loop runs long after the slowest branch ends, so stamping `completedAt = new Date()` there would collapse every branch's end timestamp to ~the slowest branch's finish and the execution timeline strip would draw every parallel bar at the same width. The engine also writes six **optional** fields populated from the per-step telemetry channel (see "LLM telemetry capture" below):

- `input` — snapshot of `step.config` at execution time. Lets the trace viewer show what the step received without joining back through the workflow definition.
- `model`, `provider` — resolved model and provider for the step's LLM work. For multi-turn executors (`agent_call`, `orchestrator`), these reflect the LAST turn.
- `inputTokens`, `outputTokens` — sum across every LLM turn the step issued.
- `llmDurationMs` — wall-clock spent inside `provider.chat()` calls. The difference `durationMs - llmDurationMs` approximates engine + tool I/O overhead and powers the latency-breakdown line in the trace viewer.

All six are absent on historical rows written before the trace-viewer work; `executionTraceSchema` is back-compatible.

## `ExecutionContext`

```typescript
interface ExecutionContext {
  executionId: string;
  workflowId: string;
  userId: string;
  inputData: Record<string, unknown>;
  stepOutputs: Record<string, unknown>; // keyed by step.id
  variables: Record<string, unknown>; // planner scratchpad
  totalTokensUsed: number;
  totalCostUsd: number;
  budgetLimitUsd?: number;
  signal?: AbortSignal;
  logger: Logger;
  stepTelemetry?: LlmTelemetryEntry[]; // see "LLM telemetry capture" below
}
```

Executors receive a **frozen snapshot** (via `snapshotContext()`) so they cannot silently mutate totals or sibling outputs. They return a `StepResult { output, tokensUsed, costUsd, nextStepIds?, skipped?, skipError? }`; the engine merges that back into the live context via `mergeStepResult()` and checkpoints. When `skipped` is true (set by the `skip` error strategy), the engine records a `'skipped'` trace entry and `skipError` carries the sanitised error message for SSE event emission.

## LLM telemetry capture

The engine threads a per-step `LlmTelemetryEntry[]` buffer through `snapshotContext(ctx, telemetryOut)` so any LLM call site can record per-turn metadata without modifying the executor's return type. Snapshots get their own array per call, which keeps concurrent parallel branches isolated. After the executor returns, the engine drains the buffer via `rollupTelemetry()` (in `lib/orchestration/trace/aggregate.ts`) into the trace entry's optional `model` / `provider` / `inputTokens` / `outputTokens` / `llmDurationMs` fields.

Two call sites push entries today:

- `runLlmCall` (used by `llm_call`, `evaluate`, `guard`, `orchestrator`, `plan`, `reflect`, `route`) — one entry per `provider.chat()` call.
- `agent_call`'s inner `runSingleTurn` — one entry per turn in the tool-use loop.

Retries do **not** reset the buffer between attempts: failed-attempt turns are billed via `AiCostLog` and the engine accumulates their `tokensUsed` / `costUsd` into the StepResult, so the trace header total matches the per-call cost sub-table. Telemetry follows the same rule — `inputTokens` / `outputTokens` / `llmDurationMs` sum across all attempts. `model` / `provider` come from the LAST telemetry entry, which is the successful attempt's last turn (failed turns precede it in time).

A new executor that hits the LLM via `runLlmCall` gets telemetry capture **for free**; one that calls `provider.chat()` directly should push to `ctx.stepTelemetry?` itself (mirror the `agent_call` pattern).

## OTEL tracing

Every step + LLM call + capability dispatch is wrapped in an OTEL span via the helpers in `lib/orchestration/tracing/`. Default registration is a no-op (zero-cost when not used); forks opt into ingestion by calling `registerOtelTracer()` after constructing their own `TracerProvider`. The span tree is `workflow.execute` → `workflow.step` → `llm.call` / `agent_call.turn` / `capability.dispatch`. Span attributes follow OpenTelemetry GenAI semantic conventions plus Sunrise extensions for execution / step / agent / cost correlation.

`AiCostLog` rows carry optional `traceId` / `spanId` columns so external trace backends can join cost data back to the originating span.

See [`tracing.md`](tracing.md) for the full guide — span tree, attribute reference, sampling, bootstrap recipes (Datadog / Honeycomb / Tempo / Langfuse), span-status semantics, and anti-patterns.

Template interpolation (`{{input}}`, `{{input.key}}`, `{{previous.output}}`, `{{<stepId>.output}}`) is applied inside `llm-runner.ts` and reads from the snapshot — so any step that ran earlier in the walk is addressable by id.

**Template limitations:** Interpolation supports one level of property access (`{{input.key}}`) but not deeper paths (`{{input.key.nested}}`). For nested data, flatten in an intermediate step or use an LLM step to extract the needed value. Interpolated values have no per-value size limit — very large objects will be serialised in full and sent to the LLM provider, relying on the provider's token limit to reject oversized prompts. The workflow execution body is capped at 256 KB for `inputData` to prevent oversized payloads.

## Executor registry

`lib/orchestration/engine/executor-registry.ts` — **BE-only**, intentionally separate from the FE `step-registry.ts` (which imports `lucide-react` for the builder palette).

```typescript
type StepExecutor = (
  step: WorkflowStep,
  ctx: Readonly<ExecutionContext>
) => Promise<StepResult>;

registerStepType(type: WorkflowStepType, executor: StepExecutor): void;
getExecutor(type: WorkflowStepType): StepExecutor;
getRegisteredTypes(): readonly WorkflowStepType[];
__resetRegistryForTests(): void;
```

Each executor self-registers at module import. The barrel at `executors/index.ts` pulls in every executor file for its side effect, which means importing **the engine** (which imports the barrel) is enough to guarantee all fifteen executors are registered.

Fifteen executors:

| Type                | File                | Reuses                                                                                                                |
| ------------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `llm_call`          | `llm-call.ts`       | `getProvider().chatStream()` + `logCost()`                                                                            |
| `tool_call`         | `tool-call.ts`      | `capabilityDispatcher.dispatch()`                                                                                     |
| `chain`             | `chain.ts`          | pass-through — real work is on child steps                                                                            |
| `route`             | `route.ts`          | classifier LLM + DAG branch selection                                                                                 |
| `parallel`          | `parallel.ts`       | fan-out marker — walker runs branches concurrently via Promise.allSettled                                             |
| `reflect`           | `reflect.ts`        | inner step + critic loop up to N iterations                                                                           |
| `plan`              | `plan.ts`           | LLM planner → stores plan on `ctx.variables`                                                                          |
| `human_approval`    | `human-approval.ts` | runs `prompt` through `interpolatePrompt(prompt, ctx)` then throws `PausedForApproval` carrying the interpolated text |
| `rag_retrieve`      | `rag-retrieve.ts`   | `searchKnowledge()` from the knowledge module                                                                         |
| `guard`             | `guard.ts`          | LLM or regex safety check, routes pass/fail                                                                           |
| `evaluate`          | `evaluate.ts`       | LLM rubric scorer, clamps to scale range                                                                              |
| `external_call`     | `external-call.ts`  | HTTP fetch with SSRF allowlist, outbound rate limiting, auth helpers                                                  |
| `agent_call`        | `agent-call.ts`     | loads agent config + runs ReAct tool loop via `executeAgentCall`                                                      |
| `send_notification` | `notification.ts`   | email or webhook notification with templated content                                                                  |
| `orchestrator`      | `orchestrator.ts`   | AI planner → multi-agent delegation loop via `executeAgentCall`                                                       |

## Error strategies

Each step carries `errorStrategy: 'retry' | 'fallback' | 'skip' | 'fail'` in its config. The fallback chain is: **step-level override → workflow-level `defaultErrorStrategy` → `'fail'`**. The workflow-level default is threaded through `ExecutionContext.defaultErrorStrategy` (set from `workflow.definition.errorStrategy` during context creation). The engine wraps each executor call in `runStepWithStrategy`:

| Strategy   | Behaviour                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `retry`    | Re-invoke the executor up to `retryCount` (default 2) with exponential backoff.                |
| `fallback` | Execute `fallbackStepId` if present; otherwise behave as `skip`.                               |
| `skip`     | Emit `step_failed { willRetry: false }` and continue with `output: null` in place of the step. |
| `fail`     | Emit `step_failed`, then `workflow_failed`, stop.                                              |

`PausedForApproval` is handled outside the strategy switch: the row is flipped to `paused_for_approval`, an `approval_required` event is yielded, and the generator returns cleanly.

**Partial-cost surfacing.** When an executor throws an `ExecutorError` carrying `tokensUsed` / `costUsd` (e.g. an `agent_call` that completed turn 1 before turn 2's `provider.chat()` failed), the engine surfaces those values onto the persisted **trace entry** for the step:

- `retry` strategy accumulates them across all attempts (failed and successful) into the StepResult so the trace header total matches `AiCostLog`.
- `skip` and `fallback` propagate them onto the StepResult instead of zeroing — the `'skipped'` trace entry records the billed cost.
- `fail` propagates them on the rethrown error so the `'failed'` trace entry records the billed cost.

`PausedForApproval` and `BudgetExceeded` follow the same shape: their `tokensUsed` / `costUsd` fields default to 0 but are populated by the retry-loop accumulator when prior retriable attempts had partial cost. The `'awaiting_approval'` trace entry now reflects that cost rather than hardcoding zero.

**Step-level events.** The trace entry is the canonical record. Step-level events are summary signals:

- A `'completed'` step yields `step_completed`.
- A `'failed'` step yields `step_failed { willRetry: false }` then `workflow_failed`.
- A `'skipped'` step yields **only** `step_failed { willRetry: false }` (no `step_completed`) — emitting both for the same step would be contradictory. Sequential and parallel paths agree on this. The persisted trace entry's `tokensUsed` / `costUsd` carry the partial; SSE clients that need that detail should read the trace.

### Non-retriable errors

`ExecutorError` carries a `retriable` flag (defaults to `true`). When `strategy === 'retry'` and the error has `retriable: false`, the engine skips retry attempts and fails immediately. This prevents pointless retries on HTTP 404, missing credentials, or host-not-allowed errors.

Notable non-retriable error codes by executor:

| Executor        | Code                            | Meaning                                                         |
| --------------- | ------------------------------- | --------------------------------------------------------------- |
| `external_call` | `host_not_allowed`              | URL hostname not in `ORCHESTRATION_ALLOWED_HOSTS`               |
| `external_call` | `missing_auth_secret`           | Auth env var not set                                            |
| `external_call` | `http_error`                    | Non-retriable HTTP status (4xx except 429)                      |
| `external_call` | `response_too_large`            | Response body exceeds `maxResponseBytes`                        |
| `external_call` | `request_aborted`               | Execution's `AbortSignal` was already triggered before the call |
| `tool_call`     | `missing_capability_slug`       | Step config has no `capabilitySlug`                             |
| `tool_call`     | `unknown_capability`            | Capability slug not registered                                  |
| `tool_call`     | `capability_inactive`           | Capability exists but is not active                             |
| `tool_call`     | `capability_disabled_for_agent` | Capability disabled for the calling agent/workflow              |
| `tool_call`     | `invalid_args`                  | Arguments failed Zod validation                                 |
| `tool_call`     | `requires_approval`             | Capability requires admin approval                              |

Retriable codes: `rate_limited`, `execution_error` (tool_call), `http_error_retriable` (429/502/503/504), `outbound_rate_limited` (external_call).

See [`external-calls.md`](./external-calls.md) for the full external_call error code table.

### Per-step timeout

Every step config supports an optional `timeoutMs` field (on `stepErrorConfigSchema`). When set, the engine wraps the executor call in `Promise.race` against a timeout. Timeout produces a non-retriable `step_timeout` `ExecutorError`.

## `POST` vs `GET` execute streams

The engine is exposed over HTTP via two routes with the same event payloads but different transport ergonomics:

| Route                                                      | Method | Body / Input                                        | Resume support                                                                           | Intended client                                                                                       |
| ---------------------------------------------------------- | ------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `/api/v1/admin/orchestration/workflows/:id/execute`        | `POST` | JSON body (`inputData`, `budgetLimitUsd`)           | Yes — `?resumeFromExecutionId=` query param routes through `human_approval` approve flow | `fetch()` + manual SSE parser (default admin UI)                                                      |
| `/api/v1/admin/orchestration/workflows/:id/execute-stream` | `GET`  | `?inputData=<json>&budgetLimitUsd=<n>` query params | No                                                                                       | Native [`EventSource`](https://developer.mozilla.org/docs/Web/API/EventSource) (query-only transport) |

Both rate-limit via `adminLimiter` (POST and GET). The GET variant is intended for same-origin usage by EventSource where headers cannot be set. They share DAG validation, the `workflowDefinitionSchema.safeParse` pre-flight, and the `isActive` gate. Disconnect semantics are also the same: client aborts cancel the stream, but the engine's `status` poll keeps the DB row honest (see [Cancellation](#cancellation) below).

## Cancellation

The engine supports two cancellation paths:

1. **Client-side abort** — the caller passes `signal: AbortSignal` in options. At the top of each DAG-walk iteration the engine checks `signal?.aborted` and yields `workflow_failed('Execution aborted by client')` if true.
2. **DB-side cancel** — `POST /executions/:id/cancel` sets `status: 'cancelled'` and `completedAt` in the database. The engine performs a lightweight `SELECT status` between steps and yields `workflow_failed('Execution cancelled by user')` when the status is `'cancelled'`. This covers the case where the SSE stream is lost but the execution row should still be terminated.

Both paths are checked before each step, not mid-step — a long-running LLM call will complete (and incur cost) before the cancellation is observed. Per-step `timeoutMs` is the recommended mitigation for expensive steps that might run longer than expected. The `AbortSignal` is not propagated into individual executor functions — only the engine's DAG-walk loop checks it. Future work may thread the signal into executors for mid-step cancellation of LLM calls.

## Budget enforcement

After every step the engine checks `ctx.totalCostUsd > budgetLimitUsd` and emits:

- `budget_warning` once the cumulative cost crosses 80% of the limit.
- `workflow_budget_exceeded { usedUsd, limitUsd, failedStepId }` immediately followed by `workflow_failed { error: 'Budget exceeded ($X.XXXX / $Y.YYYY cap)' }` if the limit is overrun; the generator then returns. The discrete `workflow_budget_exceeded` event also dispatches the same-named webhook fire-and-forget so partners can wire the cap-breach case to Slack / PagerDuty separately from the generic terminal event.

If the caller does not supply `budgetLimitUsd` the check is skipped entirely.

**Parallel batch note:** budget is checked after the entire parallel batch completes, not between branches. All branches run to completion (or failure) before the budget guard fires. Use per-step `timeoutMs` to bound individual branch cost.

### Per-execution cap resolution (improvement #39 — runaway-loop guard)

`budgetLimitUsd` is no longer a "caller-must-pass-it" parameter. Every execution-creation site (admin execute / execute-stream, the `run_workflow` capability, cron scheduler, inbound triggers, webhook triggers, rerun) resolves the effective cap via `resolveEffectiveExecutionCap()` (`app/api/v1/admin/orchestration/workflows/[id]/_shared/execute-helpers.ts`) — which wraps the pure helper `resolveMaxCostPerExecution()` (`lib/orchestration/llm/cost-caps.ts`):

```
explicit caller override
  > AiWorkflow.maxCostPerExecutionUsd
  > AiOrchestrationSettings.defaultMaxCostPerExecutionUsd
  > undefined (no cap; only the agent's monthly budget applies)
```

The resolved value is **persisted onto `AiWorkflowExecution.budgetLimitUsd`** at creation time. Resume paths and the lease-reaper read it from the row, so the cap is frozen at run-start — lowering a workflow / settings default mid-run does NOT retroactively cap an in-flight execution.

The check itself uses the **in-process running total** (`ctx.totalCostUsd`), never re-reads from `AiCostLog`. A failed cost-log write therefore does not weaken enforcement.

`BudgetExceeded`-thrown-by-executor (used by `reflect` to project the next iteration's cost before committing) takes the same code path: yields `workflow_budget_exceeded` then `workflow_failed`, with the executor's `usedUsd` / `limitUsd` carried into both events.

## Execution statuses

| Status                | Meaning                                                                                                                       |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `pending`             | Ready to run but no engine attached — set by approve/retry before the client reconnects                                       |
| `running`             | Engine is actively processing steps                                                                                           |
| `paused_for_approval` | Waiting for a human to approve a `human_approval` step                                                                        |
| `completed`           | All steps finished successfully                                                                                               |
| `failed`              | A step threw an error (or budget exceeded, or zombie-reaped, or abandoned approval, or the engine itself crashed — see below) |
| `cancelled`           | Stopped by a user via `POST /executions/:id/cancel`                                                                           |

The `pending` → `running` transition happens inside `initRun()` when the engine picks up a resume. This gap prevents the zombie reaper from sweeping rows before the client reconnects.

The terminal `failed` status is normally written by the engine's own `finalize()` (and accompanied by a `workflow.failed` hook). When the engine itself throws an uncaught error, `finalize()` never runs — in that case `drainEngine` (`lib/orchestration/scheduling/scheduler.ts`) writes `failed` directly from its catch block and emits a distinct `workflow.execution.failed` hook, so subscribers and `/executions/:id/status` see consistent terminal state immediately rather than waiting for the zombie reaper. See [Hooks — Event Types](./hooks.md#event-types) for the distinction.

## Recovery model

A long-running execution can be killed mid-step by a deploy, an OOM, a Vercel function timeout, or any other process restart. The engine treats this as a normal case: it survives the crash, picks up the row on the next maintenance tick, and resumes from the last completed step.

**Lease + heartbeat.** Every running execution holds a lease — `leaseToken` + `leaseExpiresAt` columns on `AiWorkflowExecution`. The host driving the run claims the lease in `initRun` (or atomically inside the row-create call for fresh runs) and refreshes it on every step boundary plus a periodic `setInterval` heartbeat (`HEARTBEAT_INTERVAL_MS = 60s`, lease duration `LEASE_DURATION_MS = 3 min`). Refreshes are token-scoped — only the holder of the current `leaseToken` can extend the lease, so a respawned-but-stale process can't clobber a fresh owner. After `HEARTBEAT_FAILURE_CAP = 3` consecutive DB-throw refresh failures (distinct from lease-lost, which is a `count: 0` token mismatch), the heartbeat self-cancels and logs `error`; the lease then expires naturally and the orphan sweep recovers the row. A single successful refresh resets the failure counter — transient blips don't trip the cap.

**Lease boundary type.** Internally, the engine threads a `LeaseHandle { executionId, token }` (defined in `lib/orchestration/engine/lease.ts`) through every DB-write path (`markCurrentStep`, `checkpoint`, `pauseForApproval`, `finalize`). Packaging the two strings as one typed object is a swap-bug guard — three adjacent `string` parameters could be silently misordered in a positional call (would compile, fail at runtime as a `count: 0` no-op against the wrong row). `ExecutionContext` (the executor-facing surface) deliberately does NOT carry the handle — executors are user-pluggable and must not be able to read or forge leases.

**Orphan sweep.** `processOrphanedExecutions()` (`lib/orchestration/scheduling/scheduler.ts`) queries `WHERE status='running' AND leaseExpiresAt < now()` and re-drives each row through the standard resume path (`drainEngine(resumeFromExecutionId=row.id)`). Detection latency is bounded by `LEASE_DURATION_MS + tick cadence` — typically under 4 minutes after the host disappears. The sweep runs as a background task inside the maintenance tick alongside the zombie reaper.

**Recovery cap.** `MAX_RECOVERY_ATTEMPTS = 3`. On resume, `initRun` calls `claimLease(executionId, reason)` where `reason: ClaimReason` is the discriminated string `'fresh-resume' | 'orphan-resume'`. The `'orphan-resume'` branch (chosen when the row was already `running`) increments `recoveryAttempts` atomically with the lease claim; `'fresh-resume'` (chosen for approval-pause resumes) is a clean state-machine transition that does NOT consume a recovery slot — making `claimLease` self-document at every call site. Past the cap, the orphan sweep marks the row `failed` with `errorMessage = "Recovery exhausted after N attempts"` and emits the `workflow.execution.failed` hook + `execution_crashed` webhook so operators get paged. The cap protects against deterministic-failure runs that would otherwise eat the tick budget forever.

**What survives a crash.** The trace already records every completed step (`checkpoint()` writes after each step returns). On resume, `initRun` rehydrates `ctx.totalTokensUsed`, `ctx.totalCostUsd`, and `ctx.stepOutputs` from the trace and seeds the DAG queue with successors of `row.currentStep`. Steps 1..N−1 are intact. Step N — the in-flight one when the crash hit — has two layers of recovery on top of bare re-run:

1. **Side-effect dedup via the dispatch cache.** Risky single-shot executors (`external_call`, `send_notification`, `tool_call`) consult `AiWorkflowStepDispatch` keyed on `${executionId}:${stepId}`. A cache hit returns the prior `StepResult` without re-firing the side effect. Per-step-type behaviour, key shape, and the `isIdempotent` capability opt-out are documented in [`workflows.md`](./workflows.md#idempotency-and-crash-safety).
2. **Per-turn replay for multi-turn steps** (`agent_call` single-turn mode, `orchestrator`, `reflect`). The crashed step resumes at the next turn instead of restarting from turn 0 — see "Multi-turn checkpoint state" below.

Together, these mean step N's already-completed work doesn't replay and its already-billed LLM tokens aren't paid twice.

**Multi-turn checkpoint state.** A `turns Json?` column on the `AiWorkflowRunningStep` side table (see "Running-step side table" below) holds an array of `TurnEntry` discriminated-union entries scoped to a specific step. The previous design used a single `currentStepTurns Json?` column on `AiWorkflowExecution`, but that column was logically per-step and forcibly per-execution — during a `parallel` fan-out it could only hold one branch's turns at a time, so a future multi-turn-inside-parallel configuration would silently lose state across branches. The per-step home (migration `20260519140000_ai_workflow_running_step`) is the durable fix. The shape is defined in `types/orchestration.ts`:

```typescript
type TurnEntry = AgentCallTurn | OrchestratorTurn | ReflectTurn;
```

| Kind           | Carries                                                                                                                                                                                                                                                                                                                          | Replay restores                                                                                                                                                            |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_call`   | `phase: 'continuing' \| 'terminal'`, `index`, optional `outerTurn`, `assistantContent`, tokens, cost. **Continuing**: `toolCall` + `toolResult` required (the dispatched tool and its captured result). **Terminal**: neither field present (LLM produced final content, or a `skipFollowup` capability synthesised the result). | The conversation array (one assistant + one tool message per `continuing` entry; `terminal` triggers an immediate short-circuit return with the cached `assistantContent`) |
| `orchestrator` | `round`, `plannerReasoning`, `delegations[]`, planner tokens/cost, optional `finalAnswer`                                                                                                                                                                                                                                        | The `rounds` array — next planner call sees prior rounds as context                                                                                                        |
| `reflect`      | `iteration`, `draft`, `converged` flag, tokens, cost                                                                                                                                                                                                                                                                             | The latest `draft` and the iteration counter                                                                                                                               |

The Zod surface in `lib/validations/orchestration.ts` is two-layered: `agentCallTurnSchema` is a `z.discriminatedUnion('phase', [continuing, terminal])` so one-sided entries (e.g. `phase: 'continuing'` without a `toolCall`) fail to parse. The outer `turnEntrySchema` is `z.union(...)` rather than `z.discriminatedUnion('kind', ...)` because Zod requires each member of a discriminatedUnion to be a single ZodObject — a nested discriminatedUnion (the agent_call sub-union) can't be a member directly. TS still narrows cleanly via `kind` in consumers; the per-member parse cost on a 3-member outer union is negligible. The trace entry's `turns?: TurnEntry[]` field carries the array post-termination so the admin viewer can show a completed multi-turn step's full turn history.

**Engine surface (`ctx.recordTurn` / `ctx.resumeTurns`).** The engine extends `ExecutionContext` with two optional fields. Multi-turn executors call `ctx.recordTurn?.(turn)` after each completed turn; the engine's closure appends to an in-memory accumulator AND writes the full array to the running-step row's `turns` column. The write is two-step: a lease-guarded refresh on `AiWorkflowExecution` (count=0 → stale token, skip the next write), then an `updateMany` on `AiWorkflowRunningStep` keyed by `(executionId, stepId)`. On the resume path, `initRun` looks up the running-step row for `row.currentStep`, parses its `turns` with `turnEntriesSchema`, and populates `ctx.resumeTurns`; the executor reads it on entry and rebuilds its in-memory state. After loading, the resume path also `deleteMany`s every running-step row for the execution so any stale siblings from a pre-crash `parallel` fan-out are discarded — the engine re-walks the DAG single-cursor.

`recordStepTurn` (`lib/orchestration/engine/orchestration-engine.ts`) is the lease-guarded write. Posture matches `markCurrentStep` and `checkpoint`: a DB hiccup mid-step is non-fatal — the in-memory turns array is the source of truth for THIS attempt; worst case is a re-drive starts from one turn earlier, with the dispatch cache preventing side-effect duplication on the replay.

The log level branches on the call: a normal turn-record write logs `warn` on DB failure (the standard non-fatal posture); the empty-array clear-write fired by `onAttemptStart` between retry attempts logs `error` (still non-fatal, but the failure mode is more dangerous — see [Retry-clear](#retry-clear) below).

**Resume restoration per executor.**

- **`reflect`** — filter `ctx.resumeTurns` for `kind === 'reflect'`; restore `draft` from the last entry's `draft` field, set `iterations` to `last.iteration + 1`, accumulate prior tokens/cost. If the last entry has `converged: true`, return the cached final draft immediately (no LLM call).
- **`orchestrator`** — filter for `kind === 'orchestrator'`; restore the `rounds` array from each prior entry (`round`, `plannerReasoning`, `delegations`, planner tokens/cost). If the last prior entry has `finalAnswer` set, short-circuit with the cached output (skip re-firing the planner). Otherwise resume the outer loop at `round = priorOrchTurns.length`.
- **`agent_call` (single-turn mode)** — filter for `kind === 'agent_call' && outerTurn === undefined`. If the last prior entry has `phase === 'terminal'`, the prior attempt already produced a final answer (the LLM emitted no tool calls, or a `skipFollowup` capability terminated the step) — return the cached `assistantContent` immediately. Otherwise (last entry is `phase === 'continuing'`) rebuild `currentMessages` by walking the prior entries — each `continuing` entry replays as an assistant-with-`toolCall` message followed by the tool result — and continue the inner tool-iteration loop at `iteration = priorIterTurns.length`. The `phase` discriminator is what's checked, not the absence of `toolCall`: a stray `toolCall` on a `terminal`-phase entry (which TS forbids constructing but a hand-edited DB row could produce) still triggers the short-circuit; the resume path doesn't depend on the field-presence pattern.
- **`agent_call` (multi-turn mode)** — **explicitly NOT supported** in the current implementation. The mode falls back to a fresh start on re-drive; the dispatch cache (commit 2 of PR 2) ensures inner tool calls aren't double-fired, so re-running outer turns 0..N pays only the LLM token cost, not the side-effect duplication. The blocker is that multi-turn mode interleaves outer-turn user-followup messages between `runSingleTurn` calls; the user-followup content isn't captured in `AgentCallTurn`'s shape, so a faithful conversation rebuild would need an additional outer-turn boundary marker. Documented as a known limitation; revisit if multi-turn becomes load-bearing in practice.

**Retry-clear.** `runStepWithStrategy` accepts an `onAttemptStart(attempt: number)` callback called before retry attempts (1+, never before attempt 0). `executeSingleStep` provides one that resets the in-memory `stepTurns` accumulator, clears `ctx.resumeTurns`, and writes `[]` to the running-step row's `turns` column — failed attempts' turns must not leak into the next attempt's replay state. The dispatch cache handles side-effect duplication across retry attempts; the turn-history reset handles correctness of the executor's reconstructed in-memory state. Resume replay (`ctx.resumeTurns`) is intentionally for attempt 0 only — retries always start fresh. (Note that `markCurrentStep`'s upsert intentionally does NOT touch `turns` on conflict — so a same-step re-entry from an approval-resume preserves the prior turns; only the explicit retry-clear path zeroes them.)

If the `[]` clear-write itself fails AND the host then crashes before attempt N+1's first successful turn record, a subsequent resume reads attempt N's stale entries from the running-step row's `turns`. The dispatch cache stops side-effect duplication, but the executor's reconstructed in-memory state (orchestrator round counter, agent_call message history, reflect draft) diverges from reality — token cost for the dropped attempt's partial work is lost. `recordStepTurn` logs the clear-write failure at `error` level (vs `warn` for normal turn writes) so operators can monitor; behaviour stays non-fatal because a failed retry-clear is marginally better than a failed retry attempt itself.

**Idempotency notes for executors and capability authors.** See [`workflows.md`](./workflows.md#idempotency-and-crash-safety) for per-step-type behaviour, the `isIdempotent` capability flag, and the `lookupDispatch` / `recordDispatch` contract.

**Single-owner-event contract on lease loss.** `checkpoint()`, `pauseForApproval()`, and `finalize()` all use `updateMany` with a `where: { id, leaseToken: token }` guard. `count: 0` means another host has taken over (the orphan sweep handed off the row). The engine then SUPPRESSES downstream event emission so only the new owner's events reach subscribers:

- `finalize()` returns `false` on `count: 0`. The caller in `executeInner` gates the terminal SSE event yield (`workflow_completed` / `workflow_failed`) AND the `workflow.completed` / `workflow.failed` hook on the boolean, so neither fires from the stale host.
- `pauseForApproval()` returns early on `count: 0` — no approval notification dispatch, no `workflow.paused_for_approval` hook, no `approval_required` webhook. Otherwise the user would receive an approval card for a row another host now owns; clicking it would surface a confusing "approval no longer pending" error.
- `checkpoint()` logs the warn but lets execution drain — its writes are no-ops anyway and the run will tip into the suppressed-terminal path on the next finalize.
- `markCurrentStep()` is non-fatal-by-design: it now logs a `warn` on DB throw (was silently swallowed), so connection-pool exhaustion or driver errors surface immediately rather than hiding for minutes until the next checkpoint.

**Running-step side table.** `AiWorkflowRunningStep` (migration `20260519140000_ai_workflow_running_step`) holds one row per step that's currently in flight per execution. Shape: `{ id, executionId, stepId, label, stepType, startedAt, completedAt DateTime?, turns Json? }`, unique on `(executionId, stepId)`, FK cascade on the parent execution. The previous design tracked the in-flight step via four scalar columns on `AiWorkflowExecution` (`currentStepLabel`, `currentStepType`, `currentStepStartedAt`, `currentStepTurns`), but during a `parallel` fan-out every branch's `markCurrentStep` raced on the same row — last-writer-wins on the scalars, so only one branch ever surfaced as "running" in the UI. The side table eliminates the contention: each branch INSERTs its own row.

`completedAt` is the "done waiting for siblings" marker. It's set on a parallel branch the instant that branch finishes — even though the row stays alive until the whole batch settles in the post-`Promise.allSettled` loop (migration `20260520000000_add_running_step_completed_at`). The live API surfaces it so the timeline strip can render a coloured processing segment plus a hashed grey wait segment per branch in real time, instead of showing every branch as "running" until the slowest one catches up. Null on sequential rows and on parallel branches that are still running. Pause-for-approval deliberately does NOT set it — those branches are awaiting human input, not sibling completion, and the UI treats the two states differently.

The engine's writes:

- **`markCurrentStep(lease, step)`** does a lease-guarded scalar refresh on the execution row (`currentStep` as the resume cursor + `leaseExpiresAt` / `lastHeartbeatAt`), then upserts the running-step row keyed by `(executionId, stepId)`. The upsert's `update` clause touches only `startedAt` — `turns` is preserved across retry / approval re-entry on the same stepId.
- **`markRunningStepCompleted(executionId, stepId, endedAt)`** is called from inside each parallel branch's `Promise.allSettled` callback when the branch finishes (success or failure — paused branches are skipped). It `updateMany`s the running-step row's `completedAt` to the captured `endedAt`. `updateMany` (not `update`) tolerates a missing row — non-fatal if a concurrent finalize swept it.
- **`recordStepTurn(lease, stepId, turns)`** lease-refreshes the execution row, then `updateMany`s the running-step row's `turns` column. `updateMany` (not `update`) tolerates a missing row — a concurrent finalize that already swept the row returns count=0 rather than throwing.
- **`clearRunningStep(executionId, stepId)`** is called at every step-terminate path (success, failure, skip) in both `executeSingleStep` and `executeParallelBatch`. Pause-for-approval intentionally does NOT clear — the step is still in flight, just waiting on input, and the row's `turns` is what approval-resume reads back.
- **`finalize()`** does an execution-wide `deleteMany` as a sweep, catching terminate paths that don't go through `clearRunningStep` (cancellation, fatal engine errors, paused-then-failed).

The reaper does the same self-healing sweep at the end of every tick: `deleteMany WHERE execution.status IN (completed, failed, cancelled)`. Idempotent — finds zero matches when state is healthy.

The live API surfaces this as `currentRunningSteps: Array<{ stepId, label, stepType, startedAt, completedAt: string | null, turnCount }>` (see `.context/api/orchestration-endpoints.md`). The detail view's `displayTrace` builder appends one synthesized trace row per entry — `status: 'running'` when `completedAt` is null, `status: 'completed'` (with the real `completedAt`) when it's set — so a `parallel` fan-out shows every branch simultaneously, each in its true state. The timeline strip reads sibling `completedAt`s to compute a per-fork "join time" and renders a hashed grey wait segment on every branch that finished before the slowest sibling. `turnCount` is the running-step row's `turns.length` — zero for single-shot step types, growing for `agent_call` / `orchestrator` / `reflect` as the model fires more iterations. The trace-row renders it as a "N turns" pill next to the duration so long agent calls show forward progress rather than looking frozen.

This closes the duplicate-terminal-event race that orphan handoff would otherwise produce. **AT MOST ONE host emits a terminal event for a given execution.**

**Crash-repair lease-clear.** When the engine throws an uncaught error and `finalize()` never runs, `drainEngine`'s catch block in `scheduling/scheduler.ts` writes `leaseToken: null, leaseExpiresAt: null` alongside `status: FAILED`. Without this, an orphan-resume run that crashed pre-`finalize` would leave a stale lease pinned to the terminal row. The clear is also structurally enforced by the SQL CHECK constraint `ai_workflow_execution_lease_pair_coherent` (added in migration `20260508114325_add_lease_pair_check`): `(leaseToken IS NULL) = (leaseExpiresAt IS NULL)`. Any FAILED row with a non-null `leaseToken` would violate the constraint, so the schema rejects partial-state writes from any source — admin SQL fixes, future migration scripts, contributor bugs.

**Admin force-fail interaction.** The live-engine admin route (`POST /executions/:id/force-fail`) transitions a stuck `running` / `pending` / `paused_for_approval` row to `failed` and nulls the lease columns in one conditional `updateMany` (status guarded). If the engine is still actively driving the run, its next `checkpoint()` / `markCurrentStep()` / `finalize()` write sees `count: 0` on the now-failed row and follows the same lease-lost path as a natural orphan handoff — no downstream events fire from the displaced host, the lease-coherence guard holds, and the suppressed-terminal contract above applies unchanged. The route writes a `force-failed` row to `AiWorkflowExecutionLeaseEvent` for the inspector and emits both `workflow.failed` (carrying `source: 'admin-force-fail'`) and `execution.force_failed` so subscribers can distinguish admin termination from natural failure without losing their existing wire-ups. See [`orchestration-executions-live-engine.md`](../admin/orchestration-executions-live-engine.md).

**Lease event history.** Every lease transition is recorded in `AiWorkflowExecutionLeaseEvent` (append-only, FK-cascaded from the execution row): `claimed` and `orphan-resume` on successful claims (distinct names per `ClaimReason`), `refresh-failed` when a heartbeat tick hits `count: 0`, `released` when `releaseLease()` clears the columns, and `force-failed` when the admin route terminates a row. Tokens are persisted as a 5-char redacted tail (`…ab12c`), never in full. The lease inspector drill-in (`GET /executions/:id/lease`) reads the latest 50 rows so operators can answer "is the engine restarting? has this row been claimed by multiple hosts?" without raw DB access. Successful refreshes are intentionally NOT recorded — they would dominate the table by orders of magnitude vs. the actual transitions.

**Single-instance deployment profile.** No distributed leader election or coordination service is involved (per `.context/orchestration/meta/improvement-priorities.md` Tier 4). Postgres row UPDATEs serialise on the row, which is sufficient at this scale.

## Zombie reaper

The **execution reaper** (`lib/orchestration/engine/execution-reaper.ts`) is the **absolute backstop** for rows the orphan sweep didn't pick up — typically legacy rows that pre-date the lease migration, or rows where recovery attempts somehow left them `running` without a fresh lease. Three sweeps:

- **Running zombies**: rows stuck in `running` beyond a 30-minute `updatedAt` threshold. With the recovery model in place, healthy runs have their `updatedAt` refreshed by the heartbeat — only genuinely-stuck rows fall here.
- **Stale pending**: rows stuck in `pending` beyond 1 hour (client never reconnected after approve/retry). Uses `createdAt` (not `updatedAt`) so incidental DB writes don't reset the reap timer.
- **Abandoned approvals**: rows stuck in `paused_for_approval` beyond 7 days (approval never acted on).

Called by the unified maintenance tick endpoint **after** the orphan sweep, so any row a recoverable orphan sweep can drive will already have been picked up.

## Adding a new step type

1. Add the literal to `KNOWN_STEP_TYPES` / `WorkflowStepType` in `types/orchestration.ts`.
2. Extend `lib/orchestration/workflows/validator.ts` with per-type config checks.
3. Create `lib/orchestration/engine/executors/<new-type>.ts` exporting an executor and calling `registerStepType('<new-type>', executor)` at module scope.
4. Add the import to `lib/orchestration/engine/executors/index.ts` so the barrel picks it up.
5. Also add a node to the FE `step-registry.ts` so the builder palette can render it.
6. Write a unit test for the new executor under `tests/unit/lib/orchestration/engine/executors/`.

The parity guarantee — "every FE step type has a BE executor and vice versa" — is enforced by the engine unit tests, so a missing registration fails loudly at CI time, not at runtime.

## Related

- [`workflows.md`](./workflows.md) — authoring-time validator (`validateWorkflow`)
- [`external-calls.md`](./external-calls.md) — external call executor, outbound rate limiting, auth, response limits
- [`resilience.md`](./resilience.md) — circuit breaker, provider fallback, budget UX
- [`admin-api.md`](./admin-api.md) — HTTP routes for execute / get / approve
- [`../api/sse.md`](../api/sse.md) — `sseResponse` helper used to ship the event stream
- [`../admin/workflow-builder.md`](../admin/workflow-builder.md) — the Execute button and live execution panel
- `lib/orchestration/engine/orchestration-engine.ts` — implementation
- `types/orchestration.ts` — `ExecutionEvent`, `ExecutionTraceEntry`, `LlmTelemetryEntry`, `StepResult`
- `lib/orchestration/trace/aggregate.ts` — `rollupTelemetry`, `computeTraceAggregates`, `slowOutlierThresholdMs`
- [`../admin/orchestration-observability.md`](../admin/orchestration-observability.md) — execution detail page (timeline strip, aggregates, per-step detail, filters)
