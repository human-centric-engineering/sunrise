# Workflows

Structural validation for `AiWorkflow.workflowDefinition`. Lives in `lib/orchestration/workflows/` and is consumed by the admin `/validate` route, the `/execute` route pre-flight, the builder UI, and the runtime orchestration engine.

**Execution** is implemented by `OrchestrationEngine` at `lib/orchestration/engine/` — see [`engine.md`](./engine.md) for the event stream, executor registry, checkpoint lifecycle, and error strategies. This file covers **authoring-time** validation only.

## Module Layout

```
lib/orchestration/workflows/
├── validator.ts   # validateWorkflow() — pure logic, no DB, no I/O
└── index.ts       # barrel: exports validateWorkflow + types
```

Everything under `lib/orchestration/workflows/` is **platform-agnostic** — no `next/*` imports, no Prisma calls, no `process.env` reads. The validator runs just as well inside a browser-side workflow editor as it does inside a route handler.

## The `WorkflowDefinition` Shape

Defined in `types/orchestration.ts`:

```typescript
interface WorkflowDefinition {
  entryStepId: string;
  errorStrategy: 'retry' | 'fallback' | 'skip' | 'fail';
  steps: WorkflowStep[];
}

interface WorkflowStep {
  id: string;
  name: string;
  type: 'llm_call' | 'tool_call' | 'human_approval' | 'chain' | /* ... */;
  config: Record<string, unknown>;
  nextSteps: ConditionalEdge[]; // { targetStepId: string; condition?: string; maxRetries?: number }
}
```

Zod validates the **shape** (in `createWorkflowSchema` / `updateWorkflowSchema`). `validateWorkflow` validates the **structure**: reachability, cycles, per-type config requirements.

## `validateWorkflow(def)`

```typescript
import { validateWorkflow } from '@/lib/orchestration/workflows';

const result = validateWorkflow(workflow.workflowDefinition);
if (!result.ok) {
  // result.errors is Array<{ code, message, stepId?, path? }>
}
```

Pure function. Returns `{ ok: boolean, errors: WorkflowValidationError[] }`. Never throws — malformed input surfaces as a populated `errors` array.

### Algorithm summary

1. **Duplicate ids** — scan `steps`, flag any repeated `id` (first pass, before anything else, so later passes can safely assume ids are unique).
2. **Missing entry** — check `entryStepId` resolves to a real step. If it doesn't, reachability and cycle checks are **skipped** (they'd cascade into meaningless errors).
3. **Unknown targets** — every `nextSteps.targetStepId` on every step must resolve.
4. **Per-type config** — `human_approval` requires `config.prompt`, `tool_call` requires `config.capabilitySlug`, `guard` requires `config.rules`, `evaluate` requires `config.rubric`, `external_call` requires `config.url`, `agent_call` requires `config.agentSlug`, `route` requires at least 2 entries in `config.routes`.
5. **Reachability** — BFS from `entryStepId`; any step not visited is an orphan.
6. **Cycle detection** — DFS with gray/black colouring. When a back-edge into a gray node is found, the validator checks for a **bounded retry exemption**: if the edge has both `maxRetries > 0` and a `condition`, the back-edge is allowed (the engine will enforce the retry cap at runtime). Otherwise, the DFS stack is sliced to produce the cycle `path`. Unconditional back-edges and back-edges without `maxRetries` are still flagged as cycles.

## Error codes

All errors are typed — the `code` field is the contract, **never** assert on `message` (tests depend on this). UI should render by code.

| `code`                        | `stepId?` | `path?` | Meaning                                                                                                                                                                                                                                                                                  |
| ----------------------------- | --------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MISSING_ENTRY`               | —         | —       | `entryStepId` does not resolve to any step. Cycle & reachability checks are skipped when this fires.                                                                                                                                                                                     |
| `DUPLICATE_STEP_ID`           | ✓         | —       | Two or more steps share the same `id`.                                                                                                                                                                                                                                                   |
| `UNKNOWN_TARGET`              | ✓         | —       | A step's `nextSteps[].targetStepId` doesn't match any step in the workflow.                                                                                                                                                                                                              |
| `UNREACHABLE_STEP`            | ✓         | —       | Step is not reachable from `entryStepId` via BFS — i.e. an orphan.                                                                                                                                                                                                                       |
| `CYCLE_DETECTED`              | —         | ✓       | Workflows must be DAGs. `path` contains the cycle (first → ... → first) for error rendering. **Exception:** back-edges with `maxRetries > 0` AND a `condition` are treated as bounded retry loops and exempted — see [engine.md → Bounded retry loops](./engine.md#bounded-retry-loops). |
| `MISSING_APPROVAL_PROMPT`     | ✓         | —       | A `human_approval` step is missing `config.prompt`, which the approval UI needs to render the decision.                                                                                                                                                                                  |
| `MISSING_CAPABILITY_SLUG`     | ✓         | —       | A `tool_call` step is missing `config.capabilitySlug`, which the dispatcher needs to resolve the handler.                                                                                                                                                                                |
| `MISSING_GUARD_RULES`         | ✓         | —       | A `guard` step is missing `config.rules`, which defines the safety rules to check against.                                                                                                                                                                                               |
| `MISSING_EVALUATE_RUBRIC`     | ✓         | —       | An `evaluate` step is missing `config.rubric`, which the scorer needs to assess the output.                                                                                                                                                                                              |
| `MISSING_EXTERNAL_URL`        | ✓         | —       | An `external_call` step is missing `config.url`, which is the target endpoint for the HTTP call.                                                                                                                                                                                         |
| `MISSING_AGENT_SLUG`          | ✓         | —       | An `agent_call` step is missing `config.agentSlug`, which identifies the agent to invoke.                                                                                                                                                                                                |
| `INSUFFICIENT_ROUTE_BRANCHES` | ✓         | —       | A `route` step has fewer than two branches in `config.routes`. Routes need at least two options to classify.                                                                                                                                                                             |

### Example error payload

```json
{
  "ok": false,
  "errors": [
    {
      "code": "UNKNOWN_TARGET",
      "stepId": "a",
      "message": "Step 'a' references unknown target 'ghost'"
    },
    {
      "code": "CYCLE_DETECTED",
      "path": ["a", "b", "c", "a"],
      "message": "Cycle detected: a → b → c → a"
    }
  ]
}
```

## `semanticValidateWorkflow(def)`

```typescript
import { semanticValidateWorkflow } from '@/lib/orchestration/workflows';

const result = await semanticValidateWorkflow(workflow.workflowDefinition);
if (!result.ok) {
  // result.errors is Array<{ code, message, stepId }>
}
```

DB-backed validation that checks whether a workflow's steps reference real, active resources. Separated from the pure structural `validateWorkflow()` so callers without DB access can still run structural checks independently.

Lives in `lib/orchestration/workflows/semantic-validator.ts`. Requires Prisma + model registry.

### Algorithm

1. **Collect references** — single pass over steps to extract unique model overrides (from `llm_call`, `route`, `reflect`, `guard`, `evaluate`, `plan`, `orchestrator` steps) and capability slugs (from `tool_call` steps).
2. **Batch DB queries** — two parallel queries: active providers and active capabilities matching the collected slugs.
3. **Check model overrides** — each `modelOverride` must exist in the model registry and its provider must be active.
4. **Check capability slugs** — each `capabilitySlug` must match an active capability.

### Semantic error codes

| `code`                   | `stepId` | Meaning                                                       |
| ------------------------ | -------- | ------------------------------------------------------------- |
| `UNKNOWN_MODEL_OVERRIDE` | yes      | Step references a model not in the registry                   |
| `INACTIVE_PROVIDER`      | yes      | Step's model override belongs to an inactive provider         |
| `INACTIVE_CAPABILITY`    | yes      | `tool_call` step references an inactive or unknown capability |
| `INACTIVE_AGENT`         | yes      | `agent_call` step references an inactive or unknown agent     |

The `/validate` and `/dry-run` endpoints run both structural and semantic validation. The workflow builder UI currently runs structural checks only (semantic checks require DB access).

## Consumers

| Consumer                                   | Purpose                                                               |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `POST /workflows/:id/validate`             | Live validation endpoint — wraps the result in `successResponse`      |
| `POST /workflows/:id/execute` (pre-flight) | Blocks a bad DAG from reaching the engine (400 with same error shape) |
| Session 5.1b workflow editor UI            | Live validation inside the editor as the admin edits a definition     |
| Engine pre-flight at `/execute`            | Defence-in-depth structural check before each run                     |

## Admin UI

Sessions 5.1a + 5.1b shipped the visual builder at `/admin/orchestration/workflows`, `/new`, and `/[id]`. The builder round-trips `WorkflowDefinition` JSON through React Flow via pure-TS mappers, persisting node x/y into `step.config._layout` so the next open restores the layout.

**What it ships:** canvas + pattern palette, single `PatternNode` custom type for all 15 step types, per-step config editors, live debounced validation (this validator + FE-only extra checks), red-ring errors, and a save flow (create via details dialog → POST; edit via direct PATCH).

**What it defers:** Chain sub-step editor and inline edge-condition editing are future work.

**Built-in templates (5.1c).** The toolbar's "Use template" dropdown loads 9 built-in composition recipes seeded from `prisma/seeds/data/templates/` and served to the UI via the workflows API (`GET /api/v1/admin/orchestration/workflows?isTemplate=true`). Each recipe is a full `WorkflowDefinition` matching one of the agentic patterns in `.claude/skills/agent-architect/SKILL.md` (Customer Support, Content Pipeline, SaaS Backend, Research Agent, Conversational Learning, Data Pipeline, Outreach Safety, Code Review, Autonomous Research). `prisma/seeds/004-builtin-templates.ts` upserts each template as an `AiWorkflow` row with `isTemplate: true` so they show up in the list page and can be browsed via the CRUD surface; the upsert uses `update: {}` for idempotency so re-seeding is always a no-op against admin edits.

**UI-side default config conventions.** The step registry's `defaultConfig` holds editor-facing defaults that the backend validator does not currently inspect — e.g. `llm_call.temperature = 0.7`, `parallel.timeoutMs = 60000`, `parallel.stragglerStrategy = 'wait-all'`, `rag_retrieve.topK = 5`, `rag_retrieve.similarityThreshold = 0.7`, `human_approval.timeoutMinutes = 60`. They ride along on the stored `WorkflowStep.config` JSON and are honoured opportunistically by the runtime executors (see [`engine.md`](./engine.md)). The same goes for `step.config._layout` — UI metadata, ignored by the validator and the engine.

**FE-only extra checks.** The builder also runs `runExtraChecks()` from `components/admin/orchestration/workflow-builder/extra-checks.ts` alongside `validateWorkflow()`. It adds `DISCONNECTED_NODE`, `PARALLEL_WITHOUT_MERGE`, and `MISSING_REQUIRED_CONFIG` codes that duplicate or extend this validator's coverage so the red ring appears instantly on the canvas. Session 5.2 will unify this into the backend validator when the registry lives on both sides.

See [`.context/admin/workflow-builder.md`](../admin/workflow-builder.md) for the full builder reference — pages, registry, node type, canvas interactions, layout persistence, and scope.

## Runtime execution

The validator only covers authoring. Runtime execution lives in `lib/orchestration/engine/` and is documented in full at [`engine.md`](./engine.md). Quick links:

- **`OrchestrationEngine.execute(workflow, inputData, options)`** — async generator yielding `ExecutionEvent`s and checkpointing to `AiWorkflowExecution` after each step.
- **Executor registry** — one executor per `WorkflowStep.type`; each executor self-registers via the barrel at `lib/orchestration/engine/executors/index.ts`.
- **Error strategies** — `retry`, `fallback`, `skip`, `fail` per step; budget enforcement with 80% warning.
- **Human approval pause** — `human_approval` executor throws `PausedForApproval`; engine flips the row to `paused_for_approval` and exits cleanly.

The three execute/read/approve admin routes are live; see [`admin-api.md`](./admin-api.md#executions) for the HTTP contract.

## Extending the validator

If a new step type (`WorkflowStep.type`) carries required config, add the check at the per-type-config pass in `validator.ts`. Rules:

- Add a new `code` variant to the `WorkflowValidationError['code']` union.
- Update the error-codes table above — this doc is the source of truth for error rendering.
- Add a unit test in `tests/unit/lib/orchestration/workflows/validator.test.ts` that asserts on the new `code`, not on the message.
- Never make the validator read from the DB or call `process.env`. If a check needs external data, it belongs in the engine, not the validator.

## Related

- [`engine.md`](./engine.md) — Runtime orchestration engine, executors, events
- [`admin-api.md`](./admin-api.md) — Workflow CRUD + `/validate` + live executions
- [`overview.md`](./overview.md) — Orchestration module layout
- `lib/orchestration/workflows/validator.ts` — Implementation
- `types/orchestration.ts` — `WorkflowDefinition`, `WorkflowStep`, `ConditionalEdge`, `KNOWN_STEP_TYPES`, `ExecutionEvent`, `ExecutionTraceEntry`
- `lib/validations/orchestration.ts` — `createWorkflowSchema`, `updateWorkflowSchema`, `executeWorkflowBodySchema`
