# How to Design Workflows

Workflows are DAGs (directed acyclic graphs) of steps executed by the `OrchestrationEngine`. This guide covers step types, error handling, templates, and how to extend the system.

## Quick Reference

| Concept                | Detail                                                                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Step types             | 15: `llm_call`, `tool_call`, `chain`, `route`, `parallel`, `reflect`, `plan`, `human_approval`, `rag_retrieve`, `guard`, `evaluate`, `external_call`, `agent_call`, `send_notification`, `orchestrator` |
| Templates              | 9 built-in: Customer Support, Content Pipeline, SaaS Backend, Research Agent, Conversational Learning, Data Pipeline, Outreach Safety, Code Review, Autonomous Research                                 |
| Error strategies       | 4: `retry`, `fallback`, `skip`, `fail` (default: `fail`)                                                                                                                                                |
| Validator              | `validateWorkflow()` — pure function, no DB, no I/O                                                                                                                                                     |
| Semantic validator     | `semanticValidateWorkflow()` — DB-backed checks for model overrides, capability slugs, agent slugs                                                                                                      |
| Engine                 | `OrchestrationEngine.execute()` — returns `AsyncIterable<ExecutionEvent>`                                                                                                                               |
| Template interpolation | `{{input}}`, `{{input.key}}`, `{{previous.output}}`, `{{<stepId>.output}}`                                                                                                                              |

## Workflow Definition Structure

Defined in `types/orchestration.ts`:

```typescript
interface WorkflowDefinition {
  entryStepId: string; // Where execution starts
  errorStrategy: 'retry' | 'fallback' | 'skip' | 'fail'; // Workflow-level default
  steps: WorkflowStep[]; // The DAG nodes
}

interface WorkflowStep {
  id: string; // Unique within the workflow
  name: string; // Human-readable label
  type: WorkflowStepType; // One of the 15 step types
  config: Record<string, unknown>; // Type-specific configuration
  nextSteps: ConditionalEdge[]; // Outgoing edges
}

interface ConditionalEdge {
  targetStepId: string;
  condition?: string; // Optional routing condition
}
```

## Step Type Reference

### Agent Steps

| Type         | Label      | Purpose                                                                 | Key Config                                          | Default Config                                                  |
| ------------ | ---------- | ----------------------------------------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| `llm_call`   | LLM Call   | Single model call — the basic unit                                      | `prompt`, `modelOverride`, `temperature`            | `{ prompt: '', modelOverride: '', temperature: 0.7 }`           |
| `chain`      | Chain Step | Sequential LLM call with a validation gate                              | `steps` (sub-steps array)                           | `{ steps: [] }`                                                 |
| `reflect`    | Reflect    | Draft, critique, revise loop                                            | `critiquePrompt`, `maxIterations`                   | `{ critiquePrompt: '', maxIterations: 3 }`                      |
| `plan`       | Plan       | Agent generates its own sub-plan                                        | `objective`, `maxSubSteps`                          | `{ objective: '', maxSubSteps: 5 }`                             |
| `agent_call` | Agent Call | Invoke a configured agent with its full system prompt, model, and tools | `agentSlug`, `message`, `maxToolIterations`, `mode` | `{ agentSlug: '', message: '{{input}}', maxToolIterations: 5 }` |

### Decision Steps

| Type             | Label          | Purpose                                      | Key Config                                                     | Default Config                                                      |
| ---------------- | -------------- | -------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------- |
| `route`          | Route          | Classify input and branch to different paths | `classificationPrompt`, `routes`                               | `{ classificationPrompt: '', routes: [] }`                          |
| `human_approval` | Human Approval | Pause workflow for human review              | `prompt` (required), `timeoutMinutes`, `notificationChannel`   | `{ prompt: '', timeoutMinutes: 60, notificationChannel: 'in-app' }` |
| `guard`          | Guard          | Safety gate — LLM or regex rule check        | `rules`, `mode` (`llm`/`regex`), `failAction` (`block`/`flag`) | `{ rules: '', mode: 'llm', failAction: 'block', temperature: 0.1 }` |
| `evaluate`       | Evaluate       | Score output against a rubric                | `rubric`, `scaleMin`, `scaleMax`, `threshold`                  | `{ rubric: '', scaleMin: 1, scaleMax: 5, threshold: 3 }`            |

### Input Steps

| Type            | Label         | Purpose                           | Key Config                                                                        | Default Config                                                    |
| --------------- | ------------- | --------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `tool_call`     | Tool Call     | Execute a registered capability   | `capabilitySlug` (required)                                                       | `{ capabilitySlug: '' }`                                          |
| `rag_retrieve`  | RAG Retrieve  | Search knowledge base for context | `query`, `topK`, `similarityThreshold`                                            | `{ query: '', topK: 5, similarityThreshold: 0.7 }`                |
| `external_call` | External Call | HTTP call to an external service  | `url`, `method`, `headers`, `bodyTemplate`, `timeoutMs`, `authType`, `authSecret` | `{ url: '', method: 'POST', timeoutMs: 30000, authType: 'none' }` |

### Output Steps

| Type                | Label             | Purpose                                                      | Key Config                                   | Default Config                                                         |
| ------------------- | ----------------- | ------------------------------------------------------------ | -------------------------------------------- | ---------------------------------------------------------------------- |
| `parallel`          | Parallel          | Fan out to concurrent branches, join results                 | `branches`, `timeoutMs`, `stragglerStrategy` | `{ branches: [], timeoutMs: 60000, stragglerStrategy: 'wait-all' }`    |
| `send_notification` | Send Notification | Send an email or webhook notification with templated content | `channel`, `to`, `subject`, `bodyTemplate`   | `{ channel: 'email', to: '', subject: '', bodyTemplate: '{{input}}' }` |

### Orchestration Steps

| Type           | Label        | Purpose                                                                  | Key Config                                                           | Default Config                                                                                                                      |
| -------------- | ------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `orchestrator` | Orchestrator | AI planner dynamically delegates tasks to agents and synthesizes results | `plannerPrompt`, `availableAgentSlugs`, `selectionMode`, `maxRounds` | `{ plannerPrompt: '', availableAgentSlugs: [], selectionMode: 'auto', maxRounds: 3, maxDelegationsPerRound: 5, timeoutMs: 120000 }` |

### Validator-Required Config

The backend validator (`validateWorkflow`) enforces required config for these step types:

- `human_approval` must have `config.prompt` (error: `MISSING_APPROVAL_PROMPT`)
- `tool_call` must have `config.capabilitySlug` (error: `MISSING_CAPABILITY_SLUG`)
- `guard` must have `config.rules` (error: `MISSING_GUARD_RULES`)
- `evaluate` must have `config.rubric` (error: `MISSING_EVALUATE_RUBRIC`)
- `external_call` must have `config.url` (error: `MISSING_EXTERNAL_URL`)
- `agent_call` must have `config.agentSlug` (error: `MISSING_AGENT_SLUG`)

The FE extra-checks (`runExtraChecks()`) extend this with five additional checks: required-config validations for `llm_call`, `rag_retrieve`, `plan`, `reflect`, `route`, `agent_call`, and `send_notification`; plus `DISCONNECTED_NODE` (orphaned nodes), `PARALLEL_WITHOUT_MERGE` (divergent branches), `CYCLE_DETECTED` (DFS cycle check), and `DANGLING_EDGE` (edges referencing deleted nodes). These show red-ring errors instantly on the canvas without waiting for a save round-trip.

## Error Handling Strategies

Each step can specify an `errorStrategy` that overrides the workflow-level default:

| Strategy   | Behaviour                                                                      |
| ---------- | ------------------------------------------------------------------------------ |
| `retry`    | Re-invoke the executor up to `retryCount` (default 2) with exponential backoff |
| `fallback` | Execute `fallbackStepId` if present; otherwise behave as `skip`                |
| `skip`     | Emit `step_failed { willRetry: false }` and continue with `output: null`       |
| `fail`     | Emit `step_failed`, then `workflow_failed`, stop the entire workflow           |

### When to use each strategy

- **`retry`** — transient LLM failures, rate-limited API calls. Set `retryCount` based on tolerance.
- **`fallback`** — when an alternative path exists (e.g. a simpler model, a manual lookup step).
- **`skip`** — non-critical enrichment steps where missing data is acceptable.
- **`fail`** — critical steps where continuing without a result would produce garbage output.

### Budget enforcement

After every step, the engine checks cumulative cost against `budgetLimitUsd`:

- **80% threshold** — emits `budget_warning` event
- **100% exceeded** — emits `workflow_failed { error: 'Budget exceeded' }` and stops

If no `budgetLimitUsd` is supplied, the check is skipped entirely.

## Template Interpolation

Prompts in `llm_call`, `route`, `reflect`, `plan`, `agent_call`, and `send_notification` steps support template variables resolved by `llm-runner.ts`:

| Variable              | Resolves to                                |
| --------------------- | ------------------------------------------ |
| `{{input}}`           | The workflow's `inputData` (stringified)   |
| `{{input.key}}`       | A specific key from `inputData`            |
| `{{previous.output}}` | Output of the most recently completed step |
| `{{<stepId>.output}}` | Output of a specific earlier step, by ID   |

Variables read from a frozen snapshot of `ExecutionContext`, so any step that completed earlier in the DAG walk is addressable by its `id`.

## Built-in Templates

Nine templates ship in `prisma/seeds/data/templates/`. They are loaded into the workflow builder's "Use template" dropdown and seeded as `AiWorkflow` rows with `isTemplate: true`.

### `tpl-customer-support` — Customer Support

**Patterns:** Routing (2), RAG (14), Tool Use (5), Human-in-the-Loop (13), Guardrails (18)

```
classify (route) → [self-serve] retrieve docs → search KB → draft response
                 → [human] escalate
                 → human approval → send
```

### `tpl-content-pipeline` — Content Pipeline

**Patterns:** Planning (6), Prompt Chaining (1), Reflection (4), Parallelisation (3)

```
plan → parallel(research, audience analysis) → outline → draft → reflect(critique loop)
```

### `tpl-saas-backend` — SaaS Backend

General-purpose backend automation template combining routing, tool calls, and approval gates.

### `tpl-research-agent` — Research Agent

**Patterns:** Planning (6), RAG (14), Parallelisation (3), Multi-Agent (7), Reflection (4)

```
plan → retrieve prior art → parallel(specialist 1, specialist 2, specialist 3) → synthesise → reflect
```

### `tpl-conversational-learning` — Conversational Learning

Interactive learning flow with knowledge retrieval and adaptive questioning.

### `tpl-data-pipeline` — Data Pipeline

Data ingestion, transformation, and validation workflow with parallel processing and quality gates.

### `tpl-outreach-safety` — Outreach Safety

Content generation with multi-layer safety checks — guard rails, human approval, and evaluation scoring.

### `tpl-code-review` — Code Review

Automated code review pipeline with parallel analysis, quality scoring, and structured feedback.

### `tpl-autonomous-research` — Autonomous Research

Orchestrator-driven research workflow where the AI planner dynamically delegates to specialist agents.

### Using templates

**In the workflow builder UI:** Click the "Use template" dropdown in the toolbar, select a template, and the canvas populates with the full DAG.

**Via the API:** Templates are seeded as `AiWorkflow` rows. Fetch them with `GET /api/v1/admin/orchestration/workflows` and use their `workflowDefinition` as a starting point.

**Adding a new template:** Create a new file in `prisma/seeds/data/templates/`, export a `WorkflowTemplate` object, import it in `templates/index.ts`, and append it to `BUILTIN_WORKFLOW_TEMPLATES`. The seed is idempotent and the unit test will flag invalid DAGs.

## Validation

`validateWorkflow(definition)` is a pure function that checks structural validity:

```typescript
import { validateWorkflow } from '@/lib/orchestration/workflows';

const result = validateWorkflow(workflow.workflowDefinition);
if (!result.ok) {
  // result.errors: Array<{ code, message, stepId?, path? }>
}
```

### Validation checks (in order)

1. **Duplicate IDs** — flags repeated step `id` values
2. **Missing entry** — `entryStepId` must resolve to a real step
3. **Unknown targets** — every `nextSteps.targetStepId` must resolve
4. **Per-type config** — `human_approval` needs `prompt`, `tool_call` needs `capabilitySlug`, `guard` needs `rules`, `evaluate` needs `rubric`, `external_call` needs `url`, `agent_call` needs `agentSlug`
5. **Reachability** — BFS from entry; orphan steps are flagged
6. **Cycle detection** — DFS with gray/black colouring; workflows must be acyclic

### Error codes

| Code                          | Has `stepId`? | Has `path`? | Meaning                                     |
| ----------------------------- | ------------- | ----------- | ------------------------------------------- |
| `MISSING_ENTRY`               | No            | No          | `entryStepId` doesn't resolve               |
| `DUPLICATE_STEP_ID`           | Yes           | No          | Two steps share the same `id`               |
| `UNKNOWN_TARGET`              | Yes           | No          | Edge points to non-existent step            |
| `MISSING_APPROVAL_PROMPT`     | Yes           | No          | `human_approval` missing `config.prompt`    |
| `MISSING_CAPABILITY_SLUG`     | Yes           | No          | `tool_call` missing `config.capabilitySlug` |
| `MISSING_GUARD_RULES`         | Yes           | No          | `guard` missing `config.rules`              |
| `MISSING_EVALUATE_RUBRIC`     | Yes           | No          | `evaluate` missing `config.rubric`          |
| `MISSING_EXTERNAL_URL`        | Yes           | No          | `external_call` missing `config.url`        |
| `MISSING_AGENT_SLUG`          | Yes           | No          | `agent_call` missing `config.agentSlug`     |
| `INSUFFICIENT_ROUTE_BRANCHES` | Yes           | No          | `route` step needs at least two branches    |
| `UNREACHABLE_STEP`            | Yes           | No          | Step not reachable from entry               |
| `CYCLE_DETECTED`              | No            | Yes         | DAG contains a cycle                        |

The builder UI also runs `runExtraChecks()` which adds five FE-only codes for instant canvas feedback: `DISCONNECTED_NODE`, `PARALLEL_WITHOUT_MERGE`, `MISSING_REQUIRED_CONFIG`, `CYCLE_DETECTED` (lightweight DFS, distinct from the backend's structural check), and `DANGLING_EDGE` (edges referencing deleted nodes).

### Semantic validator

`semanticValidateWorkflow()` in `lib/orchestration/workflows/semantic-validator.ts` performs DB-backed validation:

- **Model overrides** — checks that `modelOverride` values on `llm_call`, `route`, `reflect`, `guard`, `evaluate`, `plan`, and `orchestrator` steps reference real provider models
- **Capability slugs** — checks that `tool_call` steps reference active capabilities
- **Agent slugs** — checks that `agent_call` and `orchestrator` steps reference active agents

This runs on save alongside `validateWorkflow()` and returns the same error shape.

## Adding a New Step Type

Seven files need updating:

1. **`types/orchestration.ts`** — add the literal to `KNOWN_STEP_TYPES`
2. **`lib/orchestration/workflows/validator.ts`** — add per-type config checks if the new type has required config
3. **`lib/orchestration/engine/executors/<new-type>.ts`** — create the executor, call `registerStepType('<new-type>', executor)` at module scope
4. **`lib/orchestration/engine/executors/index.ts`** — add the import so the barrel picks it up
5. **`lib/orchestration/engine/step-registry.ts`** — add a `StepRegistryEntry` with icon, category, and `defaultConfig` (FE palette)
6. **`components/admin/orchestration/workflow-builder/block-editors/<new-type>-editor.tsx`** — create the config panel editor and wire it into `block-config-panel.tsx`
7. **`components/admin/orchestration/workflow-builder/extra-checks.ts`** — add required-config checks for instant canvas feedback

**Unit test** — write tests under `tests/unit/lib/orchestration/engine/executors/`.

The parity guarantee ("every FE step type has a BE executor and vice versa") is enforced by CI — a missing registration fails the engine unit tests.

### Executor signature

```typescript
type StepExecutor = (step: WorkflowStep, ctx: Readonly<ExecutionContext>) => Promise<StepResult>;

interface StepResult {
  output: unknown;
  tokensUsed: number;
  costUsd: number;
  nextStepIds?: string[]; // Override DAG edges (used by route)
}
```

Executors receive a frozen snapshot of `ExecutionContext` — they cannot mutate totals or sibling outputs. The engine merges the returned `StepResult` back into the live context.

## Example: Minimal Workflow JSON

```json
{
  "entryStepId": "step-1",
  "errorStrategy": "fail",
  "steps": [
    {
      "id": "step-1",
      "name": "Classify Intent",
      "type": "route",
      "config": {
        "classificationPrompt": "Classify the user's intent as 'question' or 'action'.",
        "routes": [
          { "label": "question", "description": "User is asking a question" },
          { "label": "action", "description": "User wants to perform an action" }
        ]
      },
      "nextSteps": [
        { "targetStepId": "step-2", "condition": "question" },
        { "targetStepId": "step-3", "condition": "action" }
      ]
    },
    {
      "id": "step-2",
      "name": "Answer Question",
      "type": "llm_call",
      "config": {
        "prompt": "Answer this question using the context: {{input}}"
      },
      "nextSteps": []
    },
    {
      "id": "step-3",
      "name": "Confirm Action",
      "type": "human_approval",
      "config": {
        "prompt": "The user wants to perform: {{input}}. Approve?"
      },
      "nextSteps": []
    }
  ]
}
```

## Related Documentation

- [Orchestration engine](../orchestration/engine.md) — runtime executor, events, checkpoint lifecycle
- [Workflow validator (service)](../orchestration/workflows.md) — validation algorithm, error codes
- [Workflow builder (UI)](./workflow-builder.md) — React Flow canvas, palette, save flow
- [Orchestration overview](./orchestration.md) — system entry point
- [Capabilities guide](./orchestration-capabilities-guide.md) — creating tools for `tool_call` steps
