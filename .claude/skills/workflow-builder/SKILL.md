---
name: workflow-builder
version: 1.0.0
description: |
  Expert workflow builder for Sunrise orchestration. Composes workflow DAGs
  using 15 step types, template interpolation, error strategies, and budget
  enforcement. Handles validation, built-in templates, and the visual builder.
  Use when creating new workflows or modifying existing ones.

triggers:
  - 'create workflow'
  - 'build workflow'
  - 'compose workflow'
  - 'new workflow'
  - 'workflow steps'
  - 'workflow dag'

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
  template_count: 9
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

| Type            | Purpose                         | Key Config                                            |
| --------------- | ------------------------------- | ----------------------------------------------------- |
| `tool_call`     | Execute a registered capability | `capabilitySlug` (required)                           |
| `rag_retrieve`  | Search knowledge base           | `query`, `topK`, `similarityThreshold`                |
| `external_call` | HTTP call to external service   | `url` (required), `method`, `headers`, `bodyTemplate` |

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

## Built-in Templates (9)

Start from these rather than building from scratch:

| Template                      | Patterns                                        |
| ----------------------------- | ----------------------------------------------- |
| `tpl-customer-support`        | Routing, RAG, Tool Use, HITL, Guardrails        |
| `tpl-content-pipeline`        | Planning, Chaining, Reflection, Parallelisation |
| `tpl-saas-backend`            | Routing, Tool Use, Approval Gates               |
| `tpl-research-agent`          | Planning, RAG, Parallelisation, Multi-Agent     |
| `tpl-conversational-learning` | RAG, Adaptive Questioning                       |
| `tpl-data-pipeline`           | Parallel Processing, Quality Gates              |
| `tpl-outreach-safety`         | Guardrails, Human Approval, Evaluation          |
| `tpl-code-review`             | Parallel Analysis, Quality Scoring              |
| `tpl-autonomous-research`     | Orchestrator, Dynamic Delegation                |

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

| Step Type        | Required Field          | Error Code                |
| ---------------- | ----------------------- | ------------------------- |
| `human_approval` | `config.prompt`         | `MISSING_APPROVAL_PROMPT` |
| `tool_call`      | `config.capabilitySlug` | `MISSING_CAPABILITY_SLUG` |
| `guard`          | `config.rules`          | `MISSING_GUARD_RULES`     |
| `evaluate`       | `config.rubric`         | `MISSING_EVALUATE_RUBRIC` |
| `external_call`  | `config.url`            | `MISSING_EXTERNAL_URL`    |
| `agent_call`     | `config.agentSlug`      | `MISSING_AGENT_SLUG`      |

### Semantic validator (`semanticValidateWorkflow`)

DB-backed checks:

- `modelOverride` values reference real provider models
- `capabilitySlug` values reference active capabilities
- `agentSlug` values reference active agents

### FE-only checks (not enforced by backend)

The backend does **not** check for empty `llm_call.prompt`, `rag_retrieve.query`, `plan.objective`, or `reflect.critiquePrompt`. Workflows created via API can pass validation with empty config and fail at runtime.

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
  "patternsUsed": ["routing", "rag"],
  "budgetLimitUsd": 5.00,
  "isActive": true
}
```

## Execution

```
POST /api/v1/admin/orchestration/executions
{
  "workflowId": "<id>",
  "inputData": { "user_query": "..." }
}
```

Returns `AsyncIterable<ExecutionEvent>`:
`workflow_started` → N × `step_started/step_completed/step_failed` → `workflow_completed/workflow_failed`

## 5-Step Workflow Creation Process

1. **Identify the pattern** — what agentic patterns apply? (routing, RAG, reflection, etc.)
2. **Select a template** — start from the closest built-in template if possible
3. **Define the DAG** — map steps, wire edges, set conditions
4. **Configure error handling** — set per-step strategies for critical vs optional steps
5. **Validate and test** — run `validateWorkflow()`, then dry-run with test input

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
