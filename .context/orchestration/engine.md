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
3. **At limit** — the back-edge is skipped silently. The engine continues to the next edge or stops if none remain.
4. **Failure context** — before re-queuing, the engine stores `ctx.variables.__retryContext`:
   ```typescript
   {
     fromStep: 'guard_step_id',
     attempt: 2,           // 1-indexed
     maxRetries: 3,
     failureReason: '...'  // guard's failure output
   }
   ```
   The retry target can reference `{{__retryContext.failureReason}}` in its prompt template to learn what went wrong.
5. **Observability** — a `step_retry` event is emitted for each retry, distinct from `step_started`, so the execution trace shows retry attempts clearly.

**Safety:** each retry iteration counts against `MAX_STEPS_PER_RUN = 1000`. Combined with the per-edge `maxRetries` cap of 10, runaway loops are doubly bounded.

**Cascade-clear:** when a retry target is re-queued, all steps reachable from that target are also cleared from `visited`. This ensures downstream steps re-execute with the retry target's fresh output rather than stale results from the previous attempt.

## `ExecutionEvent` (SSE payloads)

Defined in `types/orchestration.ts`. Discriminated union — every client switches on `event.type`:

| `type`               | Key fields                                                      |
| -------------------- | --------------------------------------------------------------- |
| `workflow_started`   | `executionId`, `workflowId`                                     |
| `step_started`       | `stepId`, `stepType`, `label`                                   |
| `step_completed`     | `stepId`, `output`, `tokensUsed`, `costUsd`, `durationMs`       |
| `step_retry`         | `fromStepId`, `targetStepId`, `attempt`, `maxRetries`, `reason` |
| `step_failed`        | `stepId`, `error`, `willRetry`                                  |
| `approval_required`  | `stepId`, `payload` (shape: `{ prompt, previous, ... }`)        |
| `budget_warning`     | `usedUsd`, `limitUsd`                                           |
| `workflow_completed` | `output`, `totalTokensUsed`, `totalCostUsd`                     |
| `workflow_failed`    | `error`, `failedStepId?`                                        |

The parallel `ExecutionTraceEntry` (also in `types/orchestration.ts`) is what the engine persists to `AiWorkflowExecution.executionTrace` — one per completed step, with `stepId`, `stepType`, `label`, `status`, `output`, `tokensUsed`, `costUsd`, `startedAt`, `completedAt`, and `durationMs`. The engine also writes six **optional** fields populated from the per-step telemetry channel (see "LLM telemetry capture" below):

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

| Type                | File                | Reuses                                                                    |
| ------------------- | ------------------- | ------------------------------------------------------------------------- |
| `llm_call`          | `llm-call.ts`       | `getProvider().chatStream()` + `logCost()`                                |
| `tool_call`         | `tool-call.ts`      | `capabilityDispatcher.dispatch()`                                         |
| `chain`             | `chain.ts`          | pass-through — real work is on child steps                                |
| `route`             | `route.ts`          | classifier LLM + DAG branch selection                                     |
| `parallel`          | `parallel.ts`       | fan-out marker — walker runs branches concurrently via Promise.allSettled |
| `reflect`           | `reflect.ts`        | inner step + critic loop up to N iterations                               |
| `plan`              | `plan.ts`           | LLM planner → stores plan on `ctx.variables`                              |
| `human_approval`    | `human-approval.ts` | throws `PausedForApproval`                                                |
| `rag_retrieve`      | `rag-retrieve.ts`   | `searchKnowledge()` from the knowledge module                             |
| `guard`             | `guard.ts`          | LLM or regex safety check, routes pass/fail                               |
| `evaluate`          | `evaluate.ts`       | LLM rubric scorer, clamps to scale range                                  |
| `external_call`     | `external-call.ts`  | HTTP fetch with SSRF allowlist, outbound rate limiting, auth helpers      |
| `agent_call`        | `agent-call.ts`     | loads agent config + runs ReAct tool loop via `executeAgentCall`          |
| `send_notification` | `notification.ts`   | email or webhook notification with templated content                      |
| `orchestrator`      | `orchestrator.ts`   | AI planner → multi-agent delegation loop via `executeAgentCall`           |

## Error strategies

Each step carries `errorStrategy: 'retry' | 'fallback' | 'skip' | 'fail'` in its config. The fallback chain is: **step-level override → workflow-level `defaultErrorStrategy` → `'fail'`**. The workflow-level default is threaded through `ExecutionContext.defaultErrorStrategy` (set from `workflow.definition.errorStrategy` during context creation). The engine wraps each executor call in `runStepWithStrategy`:

| Strategy   | Behaviour                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------- |
| `retry`    | Re-invoke the executor up to `retryCount` (default 2) with exponential backoff.                |
| `fallback` | Execute `fallbackStepId` if present; otherwise behave as `skip`.                               |
| `skip`     | Emit `step_failed { willRetry: false }` and continue with `output: null` in place of the step. |
| `fail`     | Emit `step_failed`, then `workflow_failed`, stop.                                              |

`PausedForApproval` is handled outside the strategy switch: the row is flipped to `paused_for_approval`, an `approval_required` event is yielded, and the generator returns cleanly.

**Partial-cost surfacing.** When an executor throws an `ExecutorError` carrying `tokensUsed` / `costUsd` (e.g. an `agent_call` that completed turn 1 before turn 2's `provider.chat()` failed), the engine surfaces those values:

- `retry` strategy accumulates them across all attempts (failed and successful) into the StepResult so the trace header total matches `AiCostLog`.
- `skip` and `fallback` propagate them onto the StepResult instead of zeroing — meaning a `step_completed` event for a `skipped` step now carries non-zero `tokensUsed` / `costUsd` when the partial existed. Clients that key off skip-equals-zero need to update.
- `fail` propagates them on the rethrown error so the trace `failed` entry records the billed cost.

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
- `workflow_failed { error: 'Budget exceeded' }` if the limit is overrun; the generator then returns.

If the caller does not supply `budgetLimitUsd` the check is skipped entirely.

**Parallel batch note:** budget is checked after the entire parallel batch completes, not between branches. All branches run to completion (or failure) before the budget guard fires. Use per-step `timeoutMs` to bound individual branch cost.

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

## Zombie reaper

The **execution reaper** (`lib/orchestration/engine/execution-reaper.ts`) sweeps for orphaned execution rows and marks them `failed`:

- **Running zombies**: rows stuck in `running` beyond a 30-minute threshold (process crash or disconnect). Uses `updatedAt` so that resumed executions (which preserve the original `startedAt`) aren't prematurely reaped — the resume path refreshes `updatedAt` when it flips status back to `running`.
- **Stale pending**: rows stuck in `pending` beyond 1 hour (client never reconnected after approve/retry). Uses `createdAt` (not `updatedAt`) so incidental DB writes don't reset the reap timer.
- **Abandoned approvals**: rows stuck in `paused_for_approval` beyond 7 days (approval never acted on).

Called by the unified maintenance tick endpoint.

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
