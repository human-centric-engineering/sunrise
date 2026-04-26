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

## Module layout

```
lib/orchestration/engine/
├── orchestration-engine.ts    # the class + execute() generator
├── executor-registry.ts       # BE-only registry (no UI deps)
├── context.ts                 # ExecutionContext + createContext + mergeStepResult
├── events.ts                  # ExecutionEvent factory helpers
├── errors.ts                  # ExecutorError (+ retriable flag), PausedForApproval, BudgetExceeded
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

## Parallel Execution

When a `parallel` node completes, its `nextSteps` targets are all pushed to the ready queue. The engine detects multiple ready steps (those whose predecessors have all been visited) and runs them concurrently:

1. **In-degree map** — built at DAG walk start from `step.nextSteps` edges. Maps each step to its set of predecessor step IDs.
2. **Readiness check** — a step is "ready" when all its predecessors are in the `visited` set.
3. **Batch detection** — if multiple steps are ready simultaneously, they form a parallel batch.
4. **Concurrent execution** — batch steps run via `Promise.allSettled`, each receiving a frozen snapshot of the current context.
5. **Sequential merge** — after all settle, results are merged into context one-by-one to avoid race conditions on `totalCostUsd` and `totalTokensUsed`.
6. **Convergence** — a join step (with in-degree > 1) stays in the `pending` set until all its predecessors complete, then becomes ready on the next iteration.

The `stragglerStrategy: 'wait-all'` config on parallel nodes is the implemented mode. `first-success` is not yet supported.

## `ExecutionEvent` (SSE payloads)

Defined in `types/orchestration.ts`. Discriminated union — every client switches on `event.type`:

| `type`               | Key fields                                                |
| -------------------- | --------------------------------------------------------- |
| `workflow_started`   | `executionId`, `workflowId`                               |
| `step_started`       | `stepId`, `stepType`, `label`                             |
| `step_completed`     | `stepId`, `output`, `tokensUsed`, `costUsd`, `durationMs` |
| `step_failed`        | `stepId`, `error`, `willRetry`                            |
| `approval_required`  | `stepId`, `payload` (shape: `{ prompt, previous, ... }`)  |
| `budget_warning`     | `usedUsd`, `limitUsd`                                     |
| `workflow_completed` | `output`, `totalTokensUsed`, `totalCostUsd`               |
| `workflow_failed`    | `error`, `failedStepId?`                                  |

The parallel `ExecutionTraceEntry` (also in `types/orchestration.ts`) is what the engine persists to `AiWorkflowExecution.executionTrace` — one per completed step, with `stepId`, `stepType`, `label`, `status`, `output`, `tokensUsed`, `costUsd`, `startedAt`, `completedAt`, and `durationMs`.

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
}
```

Executors receive a **frozen snapshot** (via `snapshotContext()`) so they cannot silently mutate totals or sibling outputs. They return a `StepResult { output, tokensUsed, costUsd, nextStepIds? }`; the engine merges that back into the live context via `mergeStepResult()` and checkpoints.

Template interpolation (`{{input}}`, `{{input.key}}`, `{{previous.output}}`, `{{<stepId>.output}}`) is applied inside `llm-runner.ts` and reads from the snapshot — so any step that ran earlier in the walk is addressable by id.

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

### Non-retriable errors

`ExecutorError` carries a `retriable` flag (defaults to `true`). When `strategy === 'retry'` and the error has `retriable: false`, the engine skips retry attempts and fails immediately. This prevents pointless retries on HTTP 404, missing credentials, or host-not-allowed errors.

Notable non-retriable error codes from the `external_call` executor:

| Code                    | Meaning                                                         |
| ----------------------- | --------------------------------------------------------------- |
| `request_aborted`       | Execution's `AbortSignal` was already triggered before the call |
| `outbound_rate_limited` | Per-host outbound rate limit exceeded for the target            |

See [`external-calls.md`](./external-calls.md) for the full error code table.

### Per-step timeout

Every step config supports an optional `timeoutMs` field (on `stepErrorConfigSchema`). When set, the engine wraps the executor call in `Promise.race` against a timeout. Timeout produces a non-retriable `step_timeout` `ExecutorError`.

## `POST` vs `GET` execute streams

The engine is exposed over HTTP via two routes with the same event payloads but different transport ergonomics:

| Route                                                      | Method | Body / Input                                        | Resume support                                                                           | Intended client                                                                                       |
| ---------------------------------------------------------- | ------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `/api/v1/admin/orchestration/workflows/:id/execute`        | `POST` | JSON body (`inputData`, `budgetLimitUsd`)           | Yes — `?resumeFromExecutionId=` query param routes through `human_approval` approve flow | `fetch()` + manual SSE parser (default admin UI)                                                      |
| `/api/v1/admin/orchestration/workflows/:id/execute-stream` | `GET`  | `?inputData=<json>&budgetLimitUsd=<n>` query params | No                                                                                       | Native [`EventSource`](https://developer.mozilla.org/docs/Web/API/EventSource) (query-only transport) |

Both rate-limit via `adminLimiter` on POST only — the GET variant is intended for trusted same-origin usage by EventSource where headers cannot be set. They share DAG validation, the `workflowDefinitionSchema.safeParse` pre-flight, and the `isActive` gate. Disconnect semantics are also the same: client aborts cancel the stream, but the engine's `status` poll keeps the DB row honest (see [Cancellation](#cancellation) below).

## Cancellation

The engine supports two cancellation paths:

1. **Client-side abort** — the caller passes `signal: AbortSignal` in options. At the top of each DAG-walk iteration the engine checks `signal?.aborted` and yields `workflow_failed('Execution aborted by client')` if true.
2. **DB-side cancel** — `POST /executions/:id/cancel` sets `status: 'cancelled'` and `completedAt` in the database. The engine performs a lightweight `SELECT status` between steps and yields `workflow_failed('Execution cancelled by user')` when the status is `'cancelled'`. This covers the case where the SSE stream is lost but the execution row should still be terminated.

Both paths are checked before each step, not mid-step — a long-running LLM call will complete before the cancellation is observed.

## Budget enforcement

After every step the engine checks `ctx.totalCostUsd > budgetLimitUsd` and emits:

- `budget_warning` once the cumulative cost crosses 80% of the limit.
- `workflow_failed { error: 'Budget exceeded' }` if the limit is overrun; the generator then returns.

If the caller does not supply `budgetLimitUsd` the check is skipped entirely.

## Execution statuses

| Status                | Meaning                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------- |
| `pending`             | Ready to run but no engine attached — set by approve/retry before the client reconnects |
| `running`             | Engine is actively processing steps                                                     |
| `paused_for_approval` | Waiting for a human to approve a `human_approval` step                                  |
| `completed`           | All steps finished successfully                                                         |
| `failed`              | A step threw an error (or budget exceeded, or zombie-reaped, or abandoned approval)     |
| `cancelled`           | Stopped by a user via `POST /executions/:id/cancel`                                     |

The `pending` → `running` transition happens inside `initRun()` when the engine picks up a resume. This gap prevents the zombie reaper from sweeping rows before the client reconnects.

## Zombie reaper

The **execution reaper** (`lib/orchestration/engine/execution-reaper.ts`) sweeps for orphaned execution rows and marks them `failed`:

- **Running zombies**: rows stuck in `running` beyond a 30-minute threshold (process crash or disconnect).
- **Stale pending**: rows stuck in `pending` beyond 1 hour (client never reconnected after approve/retry).
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
- `types/orchestration.ts` — `ExecutionEvent`, `ExecutionTraceEntry`, `StepResult`
