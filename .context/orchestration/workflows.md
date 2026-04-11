# Workflows

Structural validation for `AiWorkflow.workflowDefinition`. Lives in `lib/orchestration/workflows/` and is consumed by the admin `/validate` route, the `/execute` route pre-flight, the Session 5.1b editor UI, and the Session 5.2 orchestration engine.

**Scope note:** This session (Phase 3.2) ships **only the validator**. The executor, step runners, approval resume, and trace writers all land in Session 5.2 — see [Coming in Session 5.2](#coming-in-session-52).

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
  errorStrategy: 'fail' | 'continue' | 'retry';
  steps: WorkflowStep[];
}

interface WorkflowStep {
  id: string;
  name: string;
  type: 'llm_call' | 'tool_call' | 'human_approval' | 'chain' | /* ... */;
  config: Record<string, unknown>;
  nextSteps: Array<{ targetStepId: string; condition?: ConditionalEdge }>;
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
4. **Per-type config** — `human_approval` steps require `config.prompt`; `tool_call` steps require `config.capabilitySlug`. Other types have no extra requirements.
5. **Reachability** — BFS from `entryStepId`; any step not visited is an orphan.
6. **Cycle detection** — DFS with gray/black colouring. When a back-edge into a gray node is found, the current DFS stack is sliced to produce the cycle `path`.

## Error codes

All errors are typed — the `code` field is the contract, **never** assert on `message` (tests depend on this). UI should render by code.

| `code`                    | `stepId?` | `path?` | Meaning                                                                                                   |
| ------------------------- | --------- | ------- | --------------------------------------------------------------------------------------------------------- |
| `MISSING_ENTRY`           | —         | —       | `entryStepId` does not resolve to any step. Cycle & reachability checks are skipped when this fires.      |
| `DUPLICATE_STEP_ID`       | ✓         | —       | Two or more steps share the same `id`.                                                                    |
| `UNKNOWN_TARGET`          | ✓         | —       | A step's `nextSteps[].targetStepId` doesn't match any step in the workflow.                               |
| `UNREACHABLE_STEP`        | ✓         | —       | Step is not reachable from `entryStepId` via BFS — i.e. an orphan.                                        |
| `CYCLE_DETECTED`          | —         | ✓       | Workflows must be DAGs. `path` contains the cycle (first → ... → first) for error rendering.              |
| `MISSING_APPROVAL_PROMPT` | ✓         | —       | A `human_approval` step is missing `config.prompt`, which the approval UI needs to render the decision.   |
| `MISSING_CAPABILITY_SLUG` | ✓         | —       | A `tool_call` step is missing `config.capabilitySlug`, which the dispatcher needs to resolve the handler. |

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

## Consumers

| Consumer                                   | Purpose                                                               |
| ------------------------------------------ | --------------------------------------------------------------------- |
| `POST /workflows/:id/validate`             | Live validation endpoint — wraps the result in `successResponse`      |
| `POST /workflows/:id/execute` (pre-flight) | Blocks a bad DAG from reaching the engine (400 with same error shape) |
| Session 5.1b workflow editor UI            | Live validation inside the editor as the admin edits a definition     |
| Session 5.2 `OrchestrationEngine`          | Defence-in-depth pre-flight before execution                          |

## Admin UI

Session 5.1a shipped the visual builder at `/admin/orchestration/workflows`, `/new`, and `/[id]`. The builder round-trips `WorkflowDefinition` JSON through React Flow via pure-TS mappers, persisting node x/y into `step.config._layout` so the next open restores the layout.

**What it ships:** canvas, pattern palette (data-driven from `lib/orchestration/engine/step-registry.ts`), single `PatternNode` custom type for all 9 step types, click-to-select config panel shell, layout round-trip.

**What it defers:** Save (POST/PATCH), Validate (wiring this validator's `/validate` route), and Execute are rendered as disabled toolbar buttons until Session 5.1b. Per-step-type config editors also land in 5.1b.

See [`.context/admin/workflow-builder.md`](../admin/workflow-builder.md) for the full builder reference — pages, registry, node type, canvas interactions, layout persistence, and scope.

## Coming in Session 5.2

**Not yet implemented** — Phase 3.2 deliberately stops at the validator. Session 5.2 adds the real `OrchestrationEngine` under `lib/orchestration/workflows/` alongside the existing `validator.ts`:

| Future addition    | Purpose                                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `engine.ts`        | `engine.execute({ workflow, inputData, budgetLimitUsd, userId })` and `engine.resumeApproval(id, ...)` |
| Step runners       | `llm_call`, `tool_call`, `human_approval`, `chain` — one handler per `WorkflowStep.type`               |
| Trace writer       | Appends structured entries to `AiWorkflowExecution.executionTrace` as steps run                        |
| Budget enforcement | Honours `budgetLimitUsd` per-run cap using existing `costTracker.checkBudget`                          |
| Approval state     | Transitions `AiWorkflowExecution.status` through `paused_for_approval` → `running` on resume           |

Until 5.2 lands, the three execute/read/approve admin routes return `501 NOT_IMPLEMENTED` with a `Session 5.2` message. See [`admin-api.md`](./admin-api.md#executions-stubbed) for the stub contract.

## Extending the validator

If a new step type (`WorkflowStep.type`) carries required config, add the check at the per-type-config pass in `validator.ts`. Rules:

- Add a new `code` variant to the `WorkflowValidationError['code']` union.
- Update the error-codes table above — this doc is the source of truth for error rendering.
- Add a unit test in `tests/unit/lib/orchestration/workflows/validator.test.ts` that asserts on the new `code`, not on the message.
- Never make the validator read from the DB or call `process.env`. If a check needs external data, it belongs in the engine (Session 5.2), not the validator.

## Related

- [`admin-api.md`](./admin-api.md) — Workflow CRUD + `/validate` + stubbed executions
- [`overview.md`](./overview.md) — Orchestration module layout
- `lib/orchestration/workflows/validator.ts` — Implementation
- `types/orchestration.ts` — `WorkflowDefinition`, `WorkflowStep`, `ConditionalEdge`, `KNOWN_STEP_TYPES`
- `lib/validations/orchestration.ts` — `createWorkflowSchema`, `updateWorkflowSchema`, `executeWorkflowBodySchema`
