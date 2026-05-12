---
name: orchestration-workflow-builder
version: 1.0.0
description: |
  Expert workflow builder for Sunrise orchestration. Composes multi-step agent
  pipelines as workflow DAGs — routing requests to different agents, chaining
  LLM calls, adding human approval gates, running parallel branches, and
  integrating RAG retrieval. Uses 15 step types, template interpolation, error
  strategies, and budget enforcement. Use when building multi-step agent
  pipelines, adding approval flows, or connecting multiple agents in a sequence.

triggers:
  - 'create workflow'
  - 'build workflow'
  - 'compose workflow'
  - 'new workflow'
  - 'workflow steps'
  - 'workflow dag'
  - 'multi-step agent pipeline'
  - 'agent needs approval before'
  - 'route requests to different agents'
  - 'chain agent steps together'
  - 'build me a support pipeline'
  - 'parallel agent processing'
  - 'add human approval to workflow'

contexts:
  - 'lib/orchestration/workflows/validator.ts'
  - 'lib/orchestration/workflows/semantic-validator.ts'
  - 'lib/orchestration/engine/orchestration-engine.ts'
  - 'lib/orchestration/engine/step-registry.ts'
  - 'lib/orchestration/engine/executors/*.ts'
  - 'lib/orchestration/engine/llm-runner.ts'
  - 'lib/orchestration/engine/context.ts'
  - 'prisma/seeds/data/templates/*.ts'
  - 'types/orchestration.ts'
  - '.context/admin/orchestration-workflows-guide.md'
  - '.context/orchestration/engine.md'
  - '.context/orchestration/workflows.md'
  - 'lib/validations/orchestration.ts'

mcp_integrations:
  context7:
    libraries:
      - zod: '/colinhacks/zod'

parameters:
  step_types: 15
  error_strategies: ['retry', 'fallback', 'skip', 'fail']
  template_count: 12
---

# Workflow Builder Skill

## Mission

You compose production-ready workflow DAGs for the Sunrise orchestration engine. Workflows are directed acyclic graphs of steps — each step processes input and passes output to the next. Your job is to select the right step types, wire them correctly, configure error handling, and ensure the DAG validates.

## WorkflowDefinition Structure

```typescript
interface WorkflowDefinition {
  entryStepId: string; // Where execution starts
  errorStrategy: 'retry' | 'fallback' | 'skip' | 'fail'; // Workflow-level default
  steps: WorkflowStep[]; // The DAG nodes
}

interface WorkflowStep {
  id: string; // Unique within the workflow
  name: string; // Human-readable label
  type: WorkflowStepType; // One of 15 step types
  config: Record<string, unknown>; // Type-specific configuration
  nextSteps: ConditionalEdge[]; // Outgoing edges
}

interface ConditionalEdge {
  targetStepId: string;
  condition?: string; // Optional routing condition
}
```

## 15 Step Types

### Agent Steps

| Type         | Purpose                              | Key Config                                  |
| ------------ | ------------------------------------ | ------------------------------------------- |
| `llm_call`   | Single model call — the basic unit   | `prompt`, `modelOverride`, `temperature`    |
| `chain`      | Sequential LLM calls with validation | `steps` (sub-steps array)                   |
| `reflect`    | Draft, critique, revise loop         | `critiquePrompt`, `maxIterations`           |
| `plan`       | Agent generates its own sub-plan     | `objective`, `maxSubSteps`                  |
| `agent_call` | Invoke a configured agent            | `agentSlug`, `message`, `maxToolIterations` |

### Decision Steps

| Type             | Purpose                     | Key Config                                    |
| ---------------- | --------------------------- | --------------------------------------------- |
| `route`          | Classify input and branch   | `classificationPrompt`, `routes`              |
| `human_approval` | Pause for human review      | `prompt` (required), `timeoutMinutes`         |
| `guard`          | Safety gate (LLM or regex)  | `rules`, `mode` (`llm`/`regex`), `failAction` |
| `evaluate`       | Score output against rubric | `rubric`, `scaleMin`, `scaleMax`, `threshold` |

### Input Steps

| Type            | Purpose                         | Key Config                                                                                                                                                      |
| --------------- | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool_call`     | Execute a registered capability | `capabilitySlug` (required)                                                                                                                                     |
| `rag_retrieve`  | Search knowledge base           | `query`, `topK`, `similarityThreshold`, `categories`                                                                                                            |
| `external_call` | HTTP call to external service   | `url` (required), `method`, `headers`, `bodyTemplate` **or** `multipart`, `authType` (`none`/`bearer`/`api-key`/`query-param`/`basic`/`hmac`), `idempotencyKey` |

`external_call`'s `bodyTemplate` and `multipart` are **mutually exclusive** (Zod refine). HMAC auth + `multipart` is rejected at execute time with `multipart_hmac_unsupported` (the boundary varies, so signatures aren't deterministic). Multipart `data` / `filename` / `contentType` and field values are templates interpolated against the execution context before the FormData is built.

### Output Steps

| Type                | Purpose                        | Key Config                                   |
| ------------------- | ------------------------------ | -------------------------------------------- |
| `parallel`          | Fan out to concurrent branches | `branches`, `timeoutMs`, `stragglerStrategy` |
| `send_notification` | Email or webhook notification  | `channel`, `to`, `subject`, `bodyTemplate`   |

### Orchestration Steps

| Type           | Purpose                        | Key Config                                          |
| -------------- | ------------------------------ | --------------------------------------------------- |
| `orchestrator` | AI planner delegates to agents | `plannerPrompt`, `availableAgentSlugs`, `maxRounds` |

## Template Interpolation

Prompts support variables resolved from `ExecutionContext`:

| Variable              | Resolves to                                |
| --------------------- | ------------------------------------------ |
| `{{input}}`           | The workflow's `inputData` (stringified)   |
| `{{input.key}}`       | A specific key from `inputData`            |
| `{{previous.output}}` | Output of the most recently completed step |
| `{{<stepId>.output}}` | Output of a specific earlier step by ID    |

Variables read from a **frozen snapshot** — only completed steps are addressable.

## Error Strategies

| Strategy   | When to use                                      | Behaviour                                     |
| ---------- | ------------------------------------------------ | --------------------------------------------- |
| `retry`    | Transient LLM failures, rate-limited API calls   | Re-invoke up to `retryCount` with backoff     |
| `fallback` | Alternative path exists (simpler model, manual)  | Execute `fallbackStepId`; else behave as skip |
| `skip`     | Non-critical enrichment, missing data acceptable | Continue with `output: null`                  |
| `fail`     | Critical step, continuing would produce garbage  | Stop the entire workflow                      |

Each step can override the workflow-level `errorStrategy`.

## Budget Enforcement

After every step, the engine checks cumulative cost against `budgetLimitUsd`:

- **80%** — emits `budget_warning` event
- **100%** — emits `workflow_failed`, stops execution

If no `budgetLimitUsd` is set, the check is skipped.

## Built-in Templates (12)

Start from these rather than building from scratch:

| Template                       | Patterns                                        |
| ------------------------------ | ----------------------------------------------- |
| `tpl-customer-support`         | Routing, RAG, Tool Use, HITL, Guardrails        |
| `tpl-content-pipeline`         | Planning, Chaining, Reflection, Parallelisation |
| `tpl-saas-backend`             | Routing, Tool Use, Approval Gates               |
| `tpl-research-agent`           | Planning, RAG, Parallelisation, Multi-Agent     |
| `tpl-conversational-learning`  | RAG, Adaptive Questioning                       |
| `tpl-data-pipeline`            | Parallel Processing, Quality Gates              |
| `tpl-outreach-safety`          | Guardrails, Human Approval, Evaluation          |
| `tpl-code-review`              | Parallel Analysis, Quality Scoring              |
| `tpl-autonomous-research`      | Orchestrator, Dynamic Delegation                |
| `tpl-cited-knowledge-advisor`  | RAG, Citation Hygiene, Output Guard             |
| `tpl-scheduled-source-monitor` | Scheduled Triggers, RAG, Notification           |
| `tpl-provider-model-audit`     | Tool Use, Approval, Audit-Driven Config Update  |

Templates are in `prisma/seeds/data/templates/`. Fetch via API: `GET /api/v1/admin/orchestration/workflows`.

## Validation

### Backend validator (`validateWorkflow`)

Pure function, no DB. Checks in order:

1. Duplicate step IDs
2. Missing entry step
3. Unknown edge targets
4. Per-type required config (6 types enforced)
5. Reachability (BFS from entry)
6. Cycle detection (DFS)

### Required config (backend-enforced)

| Step Type        | Required Field                                                            | Error Code                |
| ---------------- | ------------------------------------------------------------------------- | ------------------------- |
| `human_approval` | `config.prompt`                                                           | `MISSING_APPROVAL_PROMPT` |
| `tool_call`      | `config.capabilitySlug`                                                   | `MISSING_CAPABILITY_SLUG` |
| `guard`          | `config.rules`                                                            | `MISSING_GUARD_RULES`     |
| `evaluate`       | `config.rubric`                                                           | `MISSING_EVALUATE_RUBRIC` |
| `external_call`  | `config.url` and one of `bodyTemplate` / `multipart` (mutually exclusive) | `MISSING_EXTERNAL_URL`    |
| `agent_call`     | `config.agentSlug`                                                        | `MISSING_AGENT_SLUG`      |

### Semantic validator (`semanticValidateWorkflow`)

DB-backed checks:

- `modelOverride` values reference real provider models
- `capabilitySlug` values reference active capabilities
- `agentSlug` values reference active agents

### FE-only checks (not enforced by backend)

The backend does **not** check for empty `llm_call.prompt`, `rag_retrieve.query`, `plan.objective`, or `reflect.critiquePrompt`. Workflows created via API can pass validation with empty config and fail at runtime.

## Versioning Lifecycle (publish / draft / rollback)

Workflows are **immutable-versioned**. `AiWorkflow` no longer stores the live definition directly. Instead:

- `AiWorkflow.publishedVersionId` pins the executions-facing snapshot.
- `AiWorkflow.draftDefinition` (nullable JSON) holds in-progress edits.
- `AiWorkflowVersion` rows are immutable snapshots — monotonic per workflow, mirrors `AiAgentVersion`.
- `AiWorkflowExecution.versionId` pins each run to the snapshot it executed.

**The single mutation point** is `lib/orchestration/workflows/version-service.ts`. Five operations, all audited:

| Operation     | Route                                  | Effect                                                                                                                                     |
| ------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Create v1     | `POST /workflows`                      | Atomic — creates the workflow row and v1 in one transaction                                                                                |
| Save draft    | `PATCH /workflows/:id`                 | Writes to `draftDefinition`; **does not affect running executions**                                                                        |
| Discard draft | `POST /workflows/:id/discard-draft`    | Nulls `draftDefinition`; published version is untouched                                                                                    |
| Publish draft | `POST /workflows/:id/publish`          | Validates (Zod + structural + semantic) then snapshots the draft as a new version; repoints `publishedVersionId`; clears `draftDefinition` |
| Rollback      | `POST /workflows/:id/rollback`         | Copies the target version into a **new** monotonic version and pins to it (chain stays append-only)                                        |
| List versions | `GET /workflows/:id/versions`          | Newest first                                                                                                                               |
| Read version  | `GET /workflows/:id/versions/:version` | Inspect a specific snapshot                                                                                                                |

**Practical implication.** When the user says "edit a workflow", PATCH writes a draft, and the running schedules / triggers / `run_workflow` calls continue to execute the previously published version. Nothing goes live until `POST /publish`. A `changeSummary` (optional, ≤500 chars) is captured on publish for the version history panel.

The legacy `workflowDefinition` column and `/definition-revert` / `/definition-history` routes were dropped — old code paths referencing them are gone.

## Creating a Workflow via API

```
POST /api/v1/admin/orchestration/workflows
{
  "name": "My Workflow",
  "slug": "my-workflow",
  "description": "What this workflow does",
  "workflowDefinition": {
    "entryStepId": "step-1",
    "errorStrategy": "fail",
    "steps": [ ... ]
  },
  "patternsUsed": [2, 14],
  "budgetLimitUsd": 5.00,
  "isActive": true
}
```

`workflowDefinition` is accepted on POST only — it becomes v1 atomically. Subsequent edits go through `PATCH` (writes to draft) and `POST /publish` (promotes the draft). `patternsUsed` is an `Int[]` of pattern numbers.

## Execution

```
POST /api/v1/admin/orchestration/executions
{
  "workflowId": "<id>",
  "inputData": { "user_query": "..." }
}
```

Returns `AsyncIterable<ExecutionEvent>`:
`workflow_started` → N × `step_started/step_completed/step_retry/step_failed/approval_required/budget_warning` → `workflow_completed/workflow_failed`

## How Workflows Get Triggered

A workflow can fire from five distinct entry points. Each pins `versionId` from the workflow's current `publishedVersionId` at invocation time.

| Trigger                   | Mechanism                                                       | Use for                                          |
| ------------------------- | --------------------------------------------------------------- | ------------------------------------------------ |
| Manual / admin            | `POST /api/v1/admin/orchestration/executions`                   | Ad-hoc runs, testing                             |
| Streaming (SSE)           | `POST /workflows/:id/execute-stream`                            | UI runs that need live `ExecutionEvent` updates  |
| Scheduled (cron)          | `AiWorkflowSchedule` row + maintenance tick                     | Recurring tasks, polling, scheduled reports      |
| Inbound trigger           | `POST /api/v1/inbound/:channel/:slug` (Slack / Postmark / HMAC) | React to email, Slack, or external system events |
| `run_workflow` capability | Chat agent invokes the workflow as a tool                       | Conversational agents that delegate to pipelines |

**Inbound triggers** use `AiWorkflowTrigger` rows (`channel` is `'slack'`, `'postmark'`, or `'hmac'`). Adapters live in `lib/orchestration/inbound/adapters/`. Each adapter handles its verification protocol (Slack signing, Postmark Basic auth, generic HMAC) and normalises the payload into a flat shape so workflow templates can write `{{ trigger.from.email }}` without knowing vendor specifics. Dedup is channel-scoped — replay protection lives on the `AiWorkflowExecution.dedupKey` UNIQUE constraint.

**Scheduled triggers** are cron expressions on `AiWorkflowSchedule`. The unified maintenance tick reads due rows and dispatches. Single-instance deployment profile — no distributed lock needed.

**`run_workflow` capability** is the bridge from chat agents into workflows. Per-agent `customConfig.allowedWorkflowSlugs` whitelist (fail-closed). The capability returns `{ status: 'pending_approval' | 'completed', ... }` and integrates with the in-chat approval card surface.

## Crash Recovery and Idempotency

Workflows survive process crashes. The skill author rarely configures this directly but should know it exists when designing long-running pipelines.

- **Lease-based recovery.** Each running execution owns a `leaseToken` + `leaseExpiresAt`. A 60-s heartbeat refreshes the lease across long single steps; a 3-minute lease expiry plus an orphan-sweep pass means a crashed host's row is re-driven from the last checkpoint by another invocation (or the next maintenance tick). Cap is 3 recovery attempts; beyond that the row is marked `failed` with `error.code = 'recovery_exhausted'`.
- **Dispatch cache (idempotency).** `AiWorkflowStepDispatch` is keyed on `(executionId, stepId)`. The three risky executors thread it: `external_call` derives an `Idempotency-Key` HTTP header from the cache key; `send_notification` caches per-step; `tool_call` consults the capability's `isIdempotent` flag (default `false` = cache active; opt-out only for naturally-safe-to-rerun capabilities).
- **Multi-turn checkpointing.** `currentStepTurns` (JSON) on the execution row persists per-turn state for `agent_call`, `orchestrator`, and `reflect`. On resume, completed turns are short-circuited so side effects don't double-fire. `agent_call` multi-turn mode is **not** supported — it falls back to a fresh start on re-drive; the dispatch cache prevents inner-side-effect duplication so the cost is LLM tokens only, not the side effect.

## 5-Step Workflow Creation Process

1. **Identify the pattern** — what agentic patterns apply? (routing, RAG, reflection, etc.)
2. **Select a template** — start from the closest built-in template if possible
3. **Define the DAG** — map steps, wire edges, set conditions
4. **Configure error handling** — set per-step strategies for critical vs optional steps
5. **Validate and test** — run `validateWorkflow()`, then dry-run with test input

## Testing

Write tests under `tests/unit/lib/orchestration/workflows/`. Follow existing patterns in that directory.

### What to test

1. **Workflow validation** — verify `validateWorkflow()` accepts valid DAGs and rejects invalid ones (missing entry, cycles, orphan steps, missing required config)
2. **Semantic validation** — verify `semanticValidateWorkflow()` catches invalid model/capability/agent references
3. **Step executors** — test individual step executor logic under `tests/unit/lib/orchestration/engine/executors/`
4. **Template interpolation** — verify `{{input}}`, `{{previous.output}}`, `{{stepId.output}}` resolve correctly

### Test template

```typescript
import { describe, it, expect } from 'vitest';
import { validateWorkflow } from '@/lib/orchestration/workflows/validator';

describe('My Workflow Definition', () => {
  const validWorkflow = {
    entryStepId: 'step-1',
    errorStrategy: 'fail' as const,
    steps: [
      {
        id: 'step-1',
        name: 'Classify',
        type: 'route' as const,
        config: { classificationPrompt: '...', routes: [...] },
        nextSteps: [{ targetStepId: 'step-2' }],
      },
      // ... more steps
    ],
  };

  it('validates a correct workflow', () => {
    const result = validateWorkflow(validWorkflow);
    expect(result.valid).toBe(true);
  });

  it('rejects a workflow with cycles', () => {
    const cyclic = { ...validWorkflow, steps: [/* steps that form a cycle */] };
    const result = validateWorkflow(cyclic);
    expect(result.valid).toBe(false);
    expect(result.errors).toContainEqual(expect.objectContaining({ code: 'CYCLE_DETECTED' }));
  });
});
```

### Running tests

```bash
npm run test -- tests/unit/lib/orchestration/workflows/
npm run test -- tests/unit/lib/orchestration/engine/executors/
```

## Verification Checklist

- [ ] `entryStepId` references an existing step
- [ ] All `nextSteps.targetStepId` values reference existing steps
- [ ] No orphan steps (all reachable from entry)
- [ ] No cycles in the DAG
- [ ] Required config fields populated for all step types
- [ ] Template variables reference only upstream steps
- [ ] `route` steps have at least 2 branches with matching conditions
- [ ] `parallel` branches are arrays of step IDs
- [ ] Budget limit set for production workflows
- [ ] Error strategies chosen per-step for critical paths
- [ ] Tests written and passing under `tests/unit/lib/orchestration/workflows/`
- [ ] `npm run validate` passes (type-check + lint + format)
- [ ] Run `/pre-pr` before merging the feature branch
