# Workflow builder

Visual editor for `AiWorkflow` definitions. Drag pattern blocks from a left-hand palette onto a React Flow canvas, connect handles to build a DAG, click a block to edit it in the right-hand panel. Landed in Phase 5 Session 5.1a; Session 5.1b added per-step config editors, live validation, and the save flow.

**Status:** Canvas + palette + custom nodes + per-step config editors + live validation with red-ring errors + save flow (create via details dialog, edit via direct PATCH) + **9 built-in templates** loadable from the toolbar + **live execution panel** backed by the orchestration engine (Session 5.2). The Execute button is enabled in edit mode and streams events into a sliding side panel. **Phase 5 additions:** step time estimates in palette, Copy JSON toolbar button, per-step error strategy overrides, execution cancellation, workflow definition version history.

**Core files:**

- `app/admin/orchestration/workflows/page.tsx` — list (server shell)
- `app/admin/orchestration/workflows/new/page.tsx` — create (server shell)
- `app/admin/orchestration/workflows/[id]/page.tsx` — edit (server shell, `notFound()` on 404) + `<WorkflowSchedulesTab>` below the builder
- `components/admin/orchestration/workflow-builder/` — all builder client islands
- `components/admin/orchestration/workflows-table.tsx` — list page client island (row actions: Edit, Duplicate, Delete)
- `components/admin/orchestration/executions-table.tsx` — executions list client island
- `lib/orchestration/engine/step-registry.ts` — single source of truth for pattern step metadata

**Dependency:** `@xyflow/react` (React Flow 12). First React Flow usage in the repo; the canvas / node-type / handle patterns established here will be reused by any future diagram UI.

## Pages

| Route                                 | File                                              | Purpose                                              |
| ------------------------------------- | ------------------------------------------------- | ---------------------------------------------------- |
| `/admin/orchestration/workflows`      | `app/admin/orchestration/workflows/page.tsx`      | List, search, pagination, active toggle, delete, dup |
| `/admin/orchestration/workflows/new`  | `app/admin/orchestration/workflows/new/page.tsx`  | Empty builder — create mode                          |
| `/admin/orchestration/workflows/[id]` | `app/admin/orchestration/workflows/[id]/page.tsx` | Hydrated builder — edit mode                         |
| `/admin/orchestration/executions`     | `app/admin/orchestration/executions/page.tsx`     | Execution list, status filter, workflow filter       |

All three are async server components. The list page calls `serverFetch(API.ADMIN.ORCHESTRATION.WORKFLOWS + '?page=1&limit=25')` with a null-safe fallback — failures surface as an empty state, never a thrown error. The edit page calls `serverFetch(API.ADMIN.ORCHESTRATION.workflowById(id))` and hands off to `notFound()` on any non-OK response.

## Layout

```
┌─────────────────────────────────────────────────────────────────────┐
│  BuilderToolbar — back · name input · template · Validate · Execute ·  Save
├──────────┬────────────────────────────────────┬─────────────────────┤
│          │                                    │                     │
│ Pattern  │           Workflow Canvas          │   ConfigPanel       │
│ Palette  │         (React Flow 12)            │  (shown on select)  │
│ 240px    │              flex-1                │       320px         │
│          │                                    │                     │
│  Agents  │        [llm_call]→[route]          │  Step type badge    │
│  Decisions│            ↓     ↓                │  Name (editable)    │
│  Inputs  │          [chain]                   │  Step id (copy)     │
│  Outputs │                                    │  Config JSON (RO)   │
│          │     Background · Controls · MiniMap│  Delete             │
└──────────┴────────────────────────────────────┴─────────────────────┘
```

When nothing is selected the right column collapses. In **create** mode the Execute button is disabled with a `title="Save the workflow before executing"` tooltip — you can only run a persisted workflow. In **edit** mode Execute opens an input dialog and then slides in an `ExecutionPanel` on the right.

## Step registry

`lib/orchestration/engine/step-registry.ts` is the data-driven source of truth for pattern step types. The palette iterates over `STEP_REGISTRY` and renders one draggable block per entry; the `PatternNode` custom node looks entries up by `type` for its icon and colour, and calls `getStepOutputs(type, config)` for dynamic output handle counts and labels.

**Entry shape:**

```ts
interface StepRegistryEntry {
  type: WorkflowStepType;
  label: string;
  description: string;
  category: 'orchestration' | 'agent' | 'decision' | 'input' | 'output';
  icon: LucideIcon;
  inputs: number; // handle count on target side
  outputs: number; // handle count on source side (route: 2, parallel: 3, rest: 1)
  patternNumber?: number; // forward-link to /learning/patterns/:n
  estimatedDuration: string; // human-readable hint, e.g. "~2-5s"
  defaultConfig: Record<string, unknown>;
}
```

Each entry carries an `estimatedDuration` hint displayed in the palette below the description (e.g. `"~2-5s"`, `"varies"`, `"manual"`).

**Fifteen entries:**

| Type                | Label             | Category      | Outputs | Pattern |
| ------------------- | ----------------- | ------------- | ------- | ------- |
| `llm_call`          | LLM Call          | agent         | 1       | 1       |
| `chain`             | Chain Step        | agent         | 1       | 1       |
| `route`             | Route             | decision      | 2       | 2       |
| `parallel`          | Parallel          | decision      | 3       | 3       |
| `reflect`           | Reflect           | agent         | 1       | 4       |
| `tool_call`         | Tool Call         | input         | 1       | 5       |
| `plan`              | Plan              | agent         | 1       | 6       |
| `human_approval`    | Human Approval    | decision      | 1       | 13      |
| `rag_retrieve`      | RAG Retrieve      | input         | 1       | 14      |
| `guard`             | Guard             | decision      | 2       | 18      |
| `evaluate`          | Evaluate          | decision      | 1       | 19      |
| `external_call`     | External Call     | input         | 1       | 15      |
| `agent_call`        | Agent Call        | agent         | 1       | 8       |
| `send_notification` | Send Notification | output        | 1       | —       |
| `orchestrator`      | Orchestrator      | orchestration | 1       | —       |

**Adding a new step type:** append an entry to `STEP_REGISTRY`. The palette, the `PatternNode`, and any future registry-driven consumer will pick it up automatically — no new component, no new JSX.

**FE/BE split:** this registry remains FE-only — it pulls in `lucide-react` icons for the palette so it cannot be imported from server code. Session 5.2 added a parallel **executor registry** at `lib/orchestration/engine/executor-registry.ts` with one `StepExecutor` per step type. A unit test enforces that both registries cover the same set of `WorkflowStepType`s, so a new step can never land with only FE or only BE support. See [`../orchestration/engine.md`](../orchestration/engine.md) for the executor contract.

### Category → colour map

All five categories have a matching entry in `STEP_CATEGORY_COLOURS` driving the node and palette chip Tailwind classes:

| Category        | Tailwind palette                                                  | Intent                              |
| --------------- | ----------------------------------------------------------------- | ----------------------------------- |
| `orchestration` | purple (`bg-purple-50` / `border-purple-300` / `text-purple-900`) | Meta-level multi-agent coordination |
| `agent`         | blue (`bg-blue-50` / `border-blue-300` / `text-blue-900`)         | LLM-facing work                     |
| `decision`      | amber (`bg-amber-50` / `border-amber-300` / `text-amber-900`)     | Branching or human-gated decisions  |
| `input`         | slate (`bg-slate-50` / `border-slate-300` / `text-slate-900`)     | Inputs and retrieval                |
| `output`        | emerald (`bg-emerald-50` / `border-emerald-300` / `text-…`)       | Fan-out / join steps                |

## Custom node type

`components/admin/orchestration/workflow-builder/node-types/pattern-node.tsx` is **one** React Flow custom node used for every pattern step. It reads `data.type` and calls `getStepOutputs(data.type, data.config)` for dynamic output handle count and labels — icon and category colour come from the registry entry.

- `inputs === 1`: one target handle stacked at the vertical midpoint.
- Output handles are computed dynamically: `guard` always shows 2 (Pass/Fail), `route` shows one per `config.routes` entry, `parallel` shows one per `config.branches` entry. Handles are stacked vertically with labels rendered beside each handle.
- `selected === true`: node root gets `ring-2 ring-primary shadow-md`.

`nodeTypes` is exported as a frozen module-scope object from `node-types/index.ts` — this is the React Flow recommended pattern and prevents unnecessary re-renders of custom node components.

## Canvas interactions

| Action                     | Effect                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Drag palette block         | HTML5 DnD — `dataTransfer.setData('application/reactflow', type)`                                                                                                     |
| Drop on canvas             | `onDrop` reads the type, **validates** against the registry, then `addNode()`                                                                                         |
| Drag from output handle    | React Flow `onConnect` → auto-labels the edge from the output handle's label (via `getStepOutputs`), then `addEdge({ ...connection, type: 'default', label }, edges)` |
| Click a node               | `setSelectedNodeId(id)` → right panel opens                                                                                                                           |
| Click the pane             | `setSelectedNodeId(null)` → right panel closes                                                                                                                        |
| Delete button (right pane) | Removes the node and every edge that references it                                                                                                                    |
| Scroll / pinch / pan       | Native React Flow (Controls + MiniMap included)                                                                                                                       |

**Snap to grid:** `snapToGrid` is on with `snapGrid={[16, 16]}`. Keeps casually-placed nodes visually aligned.

**Drop payload validation:** `onDrop` rejects any `application/reactflow` value that isn't in `STEP_REGISTRY` — a defensive check so we never materialise a node from an unknown string (security-review note).

## Block configuration panel

`components/admin/orchestration/workflow-builder/block-config-panel.tsx` — the right-hand panel. Session 5.1b replaced the read-only `config-panel.tsx` shell with a type-switched editor surface.

Structure (top to bottom):

- Read-only type badge (category colour + icon + label) and a **Delete** button that removes the node + incident edges and clears the selection.
- Editable **Name** `<Input>` with `<FieldHelp title="Step name">`. Writes back via `onLabelChange(id, value)`.
- Read-only **Step ID** with a copy-to-clipboard button. IDs are generated via `makeStepId()` (`step_<random8>`) and never change.
- A type-specific **editor** section picked from `block-editors/` via a single `switch (node.data.type)`. Each editor receives `{ config, onChange, capabilities? }` per the `EditorProps<TConfig>` interface in `block-editors/index.ts`. `onChange(partial)` bubbles to `onConfigChange(nodeId, partial)` on the builder shell, which shallow-merges the partial into `data.config`.
- An **Error handling** section (below the type-specific editor) with:
  - **Strategy** Select: "Inherit from workflow" (default), "Retry", "Fallback", "Skip", "Fail". Writes `config.errorStrategy` (or `undefined` for inherit).
  - Conditional **Retry count** number input (0–10, default 2) when strategy is "Retry". Writes `config.retryCount`.
  - Conditional **Fallback step ID** text input when strategy is "Fallback". Writes `config.fallbackStepId`.

**One panel, one switch.** Matches the "one `PatternNode` for all step types" decision from 5.1a: adding a new step type means one new `case` and one new editor file — no new panel component, no new shell wiring.

### Block editors

All editors live under `components/admin/orchestration/workflow-builder/block-editors/`. Every non-trivial field carries a `<FieldHelp title="…">` ⓘ popover; copy voice mirrors `agent-form.tsx`.

| Type                | Editor                      | Fields (default)                                                                                                                                                                                                                                                                                                                            |
| ------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `llm_call`          | `llm-call-editor.tsx`       | `prompt` (Textarea), `modelOverride` (Input, optional), `temperature` (number, 0.7), `maxTokens` (number, optional), `responseFormat` (Select: text/json, default text)                                                                                                                                                                     |
| `chain`             | `chain-editor.tsx`          | Placeholder card — sub-step tree editor lands in Session 5.1c                                                                                                                                                                                                                                                                               |
| `route`             | `route-editor.tsx`          | `classificationPrompt` (Textarea), dynamic `routes: { label }[]` list with add / remove                                                                                                                                                                                                                                                     |
| `parallel`          | `parallel-editor.tsx`       | `timeoutMs` (number, 60000), `stragglerStrategy` (Select: `wait-all` only; `first-success` reserved for future use)                                                                                                                                                                                                                         |
| `reflect`           | `reflect-editor.tsx`        | `critiquePrompt` (Textarea), `maxIterations` (number, 3), `modelOverride` (Input, optional), `temperature` (number, 0.3)                                                                                                                                                                                                                    |
| `tool_call`         | `tool-call-editor.tsx`      | `capabilitySlug` (Select populated from pre-fetched capabilities list; shows description for current selection)                                                                                                                                                                                                                             |
| `plan`              | `plan-editor.tsx`           | `objective` (Textarea), `maxSubSteps` (number, 5), `modelOverride` (Input, optional), `temperature` (number, 0.3)                                                                                                                                                                                                                           |
| `human_approval`    | `human-approval-editor.tsx` | `prompt` (Textarea), `timeoutMinutes` (number, 60), `notificationChannel` (Select: `in-app` / `email` / `slack`; last two stubbed)                                                                                                                                                                                                          |
| `rag_retrieve`      | `rag-retrieve-editor.tsx`   | `query` (Textarea), `topK` (number, 5), `similarityThreshold` (number, step 0.05, 0.7), `filters` (Textarea, JSON metadata filters, optional)                                                                                                                                                                                               |
| `guard`             | `guard-editor.tsx`          | `rules` (Textarea), `mode` (Select: `llm` / `regex`), `failAction` (Select: `block` / `flag`)                                                                                                                                                                                                                                               |
| `evaluate`          | `evaluate-editor.tsx`       | `rubric` (Textarea), `scaleMin` (number, 1), `scaleMax` (number, 5), `threshold` (number, 3), `modelOverride` (Input, optional), `temperature` (number, 0.7)                                                                                                                                                                                |
| `external_call`     | `external-call-editor.tsx`  | `url` (Input), `method` (Select), `headers` (key-value editor), `bodyTemplate` (Textarea), `responseTransform` (Select: none/jmespath/template + expression Textarea), `authType` (Select), `authSecret` (Input)                                                                                                                            |
| `orchestrator`      | `orchestrator-editor.tsx`   | `plannerPrompt` (Textarea), `availableAgentSlugs` (multi-checkbox from agents list), `selectionMode` (Select: auto/all), `maxRounds` (number, 3), `maxDelegationsPerRound` (number, 5), `timeoutMs` (number displayed as seconds, 120), `budgetLimitUsd` (number, optional), `modelOverride` (Input, optional), `temperature` (number, 0.3) |
| `agent_call`        | `agent-call-editor.tsx`     | `agentSlug` (Select populated from pre-fetched agents list), `message` (Textarea), `mode` (single-turn / multi-turn Select), `maxToolIterations` (number Input), `maxTurns` (number Input, shown in multi-turn mode)                                                                                                                        |
| `send_notification` | `notification-editor.tsx`   | `channel` (Select: email/webhook), `bodyTemplate` (Textarea); conditional: `to` (Input, email channel), `subject` (Input, email), `webhookUrl` (Input, webhook channel)                                                                                                                                                                     |

**Capabilities fetch.** The builder shell calls `apiClient.get(API.ADMIN.ORCHESTRATION.CAPABILITIES, { params: { limit: 100 } })` once on mount and passes the result down as `props.capabilities` to `BlockConfigPanel`. `tool-call-editor.tsx` validates the selected slug against this list before calling `onChange`, so an unknown slug can never reach the config.

**Route branch labels.** `route-editor.tsx` writes to `config.routes = [{ label }]`. Each label maps to an output handle on the node. When a user draws an edge from a specific output handle, `onConnect` auto-labels the edge with the corresponding output label (lowercased). `flowToWorkflowDefinition` also derives the `condition` from `sourceHandle` when no explicit label is set, ensuring edges reconnect to the correct handles on reload.

**Dynamic handle counts.** `getStepOutputs(type, config)` in `step-registry.ts` computes the output count and labels dynamically from step config: `guard` always returns 2 (Pass/Fail), `route` derives from `config.routes` length, `parallel` derives from `config.branches` length. `PatternNode` calls this function to render the correct number of source handles. Adding or removing branches in the editor immediately updates the node's handle count on the canvas.

### Default configuration

`lib/orchestration/engine/step-registry.ts` holds a `defaultConfig` per entry that matches the editor fields. Dropping a fresh block onto the canvas gives it sensible initial values so the first validation pass highlights only the empty _required_ fields.

## Validation

Live validation runs client-side on every change, **debounced at 300ms**:

```
nodes/edges change ─┐
                    ├─► setTimeout(300) ─► flowToWorkflowDefinition
                    ┘                      ├─► validateWorkflow()  (authoritative backend-aligned)
                                           └─► runExtraChecks()    (FE-only)
                                                ├─► setValidationErrors(combined)
                                                └─► setNodes(prev => mark data.hasError)
```

- **`validateWorkflow(def).errors`** — from `lib/orchestration/workflows/validator.ts`. Covers `MISSING_ENTRY`, `UNKNOWN_TARGET`, `UNREACHABLE_STEP`, `CYCLE_DETECTED`, `DUPLICATE_STEP_ID`, `MISSING_APPROVAL_PROMPT`, `MISSING_CAPABILITY_SLUG`, `MISSING_GUARD_RULES`, `MISSING_EVALUATE_RUBRIC`, `MISSING_EXTERNAL_URL`, `MISSING_AGENT_SLUG`, `INSUFFICIENT_ROUTE_BRANCHES` (12 codes total). This is the authoritative validator — the backend runs the same code on POST / PATCH.
- **`runExtraChecks(nodes, edges)`** — `components/admin/orchestration/workflow-builder/extra-checks.ts`. Pure TS. Five FE-only checks that run alongside the backend validator for instant canvas feedback:
  - `DISCONNECTED_NODE` — a non-entry node with zero incoming **and** zero outgoing edges.
  - `PARALLEL_WITHOUT_MERGE` — a `parallel` step whose branches never reconverge at a single downstream node.
  - `MISSING_REQUIRED_CONFIG` — type-specific emptiness: `llm_call.prompt`, `tool_call.capabilitySlug`, `human_approval.prompt`, `route.classificationPrompt`, `route.routes.length ≥ 2`, `rag_retrieve.query`, `plan.objective`, `reflect.critiquePrompt`, `guard.rules`, `evaluate.rubric`, `external_call.url`, `orchestrator.plannerPrompt`, `orchestrator.availableAgentSlugs`, `agent_call.agentSlug`, `agent_call.message`, `send_notification.bodyTemplate` (plus channel-specific checks). Some of these duplicate backend checks so the red ring appears instantly on the canvas without waiting for a save round-trip.
  - `CYCLE_DETECTED` — lightweight DFS cycle detection on the React Flow graph. Distinct from the backend's structural cycle check — the FE version runs on every debounced change for instant feedback.
  - `DANGLING_EDGE` — edges whose source or target node no longer exists. React Flow can leave these behind after node deletion; `flowToWorkflowDefinition` silently filters them, but the user should know.

`ExtraCheckError` has the same `{ code, message, stepId? }` shape as the core validator's `WorkflowValidationError`, so the summary panel merges both lists without any type gymnastics.

### Red ring on the canvas

`PatternNode` reads a transient `data.hasError: boolean` flag. The debounced effect in `workflow-builder.tsx` builds a `Set<string>` of stepIds from the combined error list and shallow-merges `hasError` into each node. The custom node renders `ring-2 ring-red-500 dark:ring-red-400` when set and falls back to `ring-primary` for the normal selected state. A visually-hidden `<span className="sr-only">Step has validation errors</span>` is emitted so screen readers announce the state.

`hasError` is **UI state, not config**. `flowToWorkflowDefinition` only serialises `node.data.config`, so the flag never reaches the stored `WorkflowDefinition`.

### Summary panel

`validation-summary-panel.tsx` renders above the canvas with `role="status" aria-live="polite"`, so the AT layer announces changes even when the user has not clicked Validate. Each error row is a button that calls `onFocusNode(stepId)`, which the builder shell wires to `useReactFlow().setCenter(node.position.x + 100, node.position.y + 40, { zoom: 1.2, duration: 400 })`. Errors without a `stepId` (e.g. `MISSING_ENTRY`) render as disabled buttons.

The **Validate** toolbar button does not fire any network request — validation is cheap and local. It simply calls `summaryPanelRef.current?.scrollIntoView({ behavior: 'smooth' })` so the panel pops into view and the aria-live update re-announces.

## Saving

`components/admin/orchestration/workflow-builder/workflow-save.ts` is a pure helper that serialises React Flow state via `flowToWorkflowDefinition(nodes, edges, { errorStrategy })` and POSTs or PATCHes via `apiClient`. Keeping it outside the React component makes it trivial to unit-test.

Request body shape for both create and edit:

```ts
{
  name: string;
  slug: string;
  description: string;
  workflowDefinition: WorkflowDefinition; // { steps, entryStepId, errorStrategy }
  isTemplate: boolean;
}
```

### Create flow (first save)

The POST schema requires `slug` and `description`, which the canvas does not capture. On the **first** create save the builder shell opens `WorkflowDetailsDialog` (shadcn `<Dialog>`) to collect:

- **Slug** — auto-derived from the workflow name via a local `slugify()` helper, but the dialog stops auto-deriving once the user types in the slug field (`slugTouched` state). Validated against `/^[a-z0-9]+(?:-[a-z0-9]+)*$/` before the Confirm button enables.
- **Description** — free-text, required non-empty.
- **Error strategy** — Select over `fail` / `retry` / `skip` / `fallback`, defaults to `fail`. Threaded through `flowToWorkflowDefinition` opts. Individual steps can override this via the block config panel's error handling section.
- **Is template** — Checkbox, default false.

Confirming calls `performSave(resolved)` → `saveWorkflow()` → on success `router.push('/admin/orchestration/workflows/:id')`. On subsequent saves the shell holds the resolved `details` in state and skips the dialog.

### Edit flow

The edit page seeds `details` from the fetched `AiWorkflow` in `initialState()`, so the details dialog never opens — the Save button calls `performSave(details)` directly, which PATCHes `API.ADMIN.ORCHESTRATION.workflowById(id)` and calls `router.refresh()` to pick up the updated record.

### Error surfacing

Save errors render as an inline red alert above the canvas (`role="alert"` + `AlertCircle` icon). The same pattern as `agent-form.tsx` — no toast library in the repo. `APIClientError.message` is sanitised by the API client before it reaches the builder; we log the full error via `logger.error('Workflow save failed', …)` and show `err.message` (already server-sanitised) to the user.

### Toolbar wiring

`builder-toolbar.tsx` accepts `{ onValidate, onSave, onExecute, onCopyJson, onSaveAsTemplate, savingAsTemplate, savedAsTemplate, onTemplateSelect, templatesDisabled, saving, hasErrors, mode }`. **Copy JSON** (`ClipboardCopy` icon) copies the current canvas as a `WorkflowDefinition` JSON to the clipboard with `_layout` keys stripped via `stripLayout()`. The Save button renders a `Loader2` spinner while `saving === true` and applies `ring-2 ring-red-500/60` when `hasErrors === true` to draw attention to the summary panel. Execute is **disabled** in create mode with `title="Save the workflow before executing"` and **enabled** in edit mode, where clicking it fires `onExecute` — see [Execution panel](#execution-panel) below.

**Save as template** — visible only in edit mode (`BookmarkPlus` icon). Calls `POST /api/v1/admin/orchestration/workflows/:id/save-as-template`, which clones the current definition into a new `isTemplate: true` row with a generated slug. Shows a spinner while in flight and a checkmark for 2.5 s on success. Errors surface via the save-error alert.

## Templates

9 built-in composition recipes are seeded into the database via `prisma/seeds/004-builtin-templates.ts` and served to the UI through the existing workflows API (`GET /api/v1/admin/orchestration/workflows?isTemplate=true`). The builder pages prefetch templates server-side and pass them as `initialTemplates` props — the same pattern used for capabilities.

**Seed data** (all under `prisma/seeds/data/templates/`):

| File                         | Template                                         | Patterns                                                           |
| ---------------------------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| `types.ts`                   | `WorkflowTemplate` shape                         | —                                                                  |
| `customer-support.ts`        | Customer Support                                 | Routing (2), Retrieval (9), Tool Use (6), HITL (7)                 |
| `content-pipeline.ts`        | Content Pipeline                                 | Planning (5), Parallelisation (3), Reflection (1)                  |
| `saas-backend.ts`            | SaaS Backend                                     | Routing (2), Prompt Chaining (4), Tool Use (6)                     |
| `research-agent.ts`          | Research Agent                                   | Planning (5), Retrieval (9), Parallelisation (3), Reflection (1)   |
| `conversational-learning.ts` | Conversational Learning                          | Memory (8), Prompt Chaining (4), Tool Use (6), Reflection (1)      |
| `code-review.ts`             | Code Review Agent                                | Parallelisation (3), Guard (18), Reflection (1), Evaluate (19)     |
| `data-pipeline.ts`           | Data Pipeline + Quality Gate                     | External Call (15), Guard (18), Parallelisation (3), Evaluate (19) |
| `outreach-safety.ts`         | Multi-Channel Outreach                           | Guard (18), Routing (2), Evaluate (19), HITL (7)                   |
| `autonomous-research.ts`     | Autonomous Research                              | RAG Retrieve (14), Orchestrator, Guard (18), Evaluate (19)         |
| `index.ts`                   | `BUILTIN_WORKFLOW_TEMPLATES` barrel + re-exports | —                                                                  |

**Template shape** (seed-side `WorkflowTemplate` in `types/orchestration.ts`):

```ts
interface WorkflowTemplate {
  slug: string;
  name: string;
  shortDescription: string;
  patterns: { number: number; name: string }[];
  flowSummary: string;
  useCases: { title: string; scenario: string }[];
  workflowDefinition: WorkflowDefinition;
}
```

**UI-side type** (`TemplateItem` in `components/.../template-types.ts`):

The `toTemplateItem()` mapper converts an `AiWorkflow` API response into a `TemplateItem`, Zod-parsing `workflowDefinition` and `metadata` JSON columns. The `metadata` column stores `WorkflowTemplateMetadata` (`flowSummary`, `useCases`, `patterns`) populated by the 004 seed unit.

Each recipe has 3–6 step types with realistic (non-stub) config. Every `tool_call` references one of the built-in capability slugs: `search_knowledge_base`, `get_pattern_detail`, `estimate_workflow_cost`, `escalate_to_human`. Every `llm_call` has a non-empty prompt. Every `route` has ≥2 branches and all parallel branches reconverge — each template passes both `validateWorkflow()` and `runExtraChecks()` out of the box.

### Dropdown → dialog → canvas

1. **Use template** button in `builder-toolbar.tsx` is a shadcn `DropdownMenu`. It renders one `DropdownMenuItem` per template (passed via `templates` prop from prefetched API data) showing `name` + `description`, and calls `onTemplateSelect(template)` on click.
2. The builder shell opens `TemplateDescriptionDialog` (`components/admin/orchestration/workflow-builder/template-description-dialog.tsx`) — a shadcn `Dialog` displaying name, description, pattern badges, use cases, and flow summary, with a confirm button whose copy flips based on canvas state:
   - Empty canvas → **Use this template** (no warning).
   - Canvas with nodes → **Replace canvas with template** plus an amber `role="alert"` warning that loading will replace every node and edge.
3. Confirming runs `handleTemplateConfirm()`: `workflowDefinitionToFlow(template.workflowDefinition)` produces the new nodes/edges, the shell calls `setNodes` / `setEdges` / `setWorkflowName`, clears selection + save error, and closes the dialog. The mapper is the exact same helper the edit page uses to hydrate an existing workflow, so layout metadata is preserved.

### Edit-mode scoping

Templates can only be loaded on a new workflow. In edit mode the shell passes `templatesDisabled={true}` and the toolbar renders every dropdown item with `disabled` plus a hint (`"Templates can only be loaded on a new workflow."`) — loading a template into an existing workflow would clobber the admin's definition and there is no undo.

### DB rows for the list page

`prisma/seeds/004-builtin-templates.ts` loops `BUILTIN_WORKFLOW_TEMPLATES` and upserts each as an `AiWorkflow` row with `isTemplate: true`, `isActive: true`, `patternsUsed`, `metadata: { flowSummary, useCases, patterns }`, and `createdBy: adminUser.id`. The `hashInputs` array lists all template source files so edits trigger re-seeding. Re-running `npm run db:seed` is safe — metadata is always overwritten (template-intrinsic, not admin-editable), but admin edits to other fields are preserved. The builder's dropdown depends on the API serving these rows.

## Layout persistence

The builder round-trips the stored `WorkflowDefinition` JSON through React Flow via `components/admin/orchestration/workflow-builder/workflow-mappers.ts`:

- **`workflowDefinitionToFlow(def)`** — turns each `WorkflowStep` into a `PatternNode`. Position: if `step.config._layout = { x, y }` exists, use it verbatim; otherwise run a simple BFS levelling from `entryStepId` (`x = level * 260`, `y = idxInLevel * 140`). One edge per `ConditionalEdge`; `condition` string becomes the edge label.
- **`flowToWorkflowDefinition(nodes, edges, opts)`** — inverse. Stashes each node's `x/y` back into `step.config._layout` on save. Strips any pre-existing `_layout` first so layouts don't nest on re-save. Derives `entryStepId` as the first node with no incoming edge (fallback: first node in the list).

**Why `_layout` in config?** `WorkflowStep.config` is `Record<string, unknown>` on the type side and a JSON column at the Prisma level — no schema change needed. The leading underscore signals "internal/UI metadata" to any future backend consumer (the validator already ignores unknown config keys).

The mapper module is **pure TypeScript** — no React / React Flow imports. It's unit-tested in isolation without DOM setup.

## Scope

Session 5.1a + 5.1b + 5.1c **ship:**

- Three pages reachable from the sidebar (list, new, edit).
- Full list table with search, pagination, active switch, delete.
- Drag from palette, drop, snap-to-grid, connect handles, click-to-select, rename, delete.
- Hydrated builder on `/[id]` from the stored `WorkflowDefinition`, including layout.
- Per-step config editors for all fifteen step types (5.1b).
- Live debounced validation combining the backend validator + three FE-only extra checks, with red-ring error rendering and an aria-live summary panel (5.1b).
- Save flow: create via `WorkflowDetailsDialog` → POST → redirect; edit via direct PATCH → refresh (5.1b).
- 9 built-in templates loadable from the toolbar dropdown (served via API), with a description dialog that warns before replacing a non-empty canvas and is disabled in edit mode (5.1c).

**Deferred:**

- **Chain sub-step editor** — placeholder card in 5.1b; tree editor is future work.
- **Inline edge condition editor** — click edge → condition textarea. Future work.
- **Per-capability argument schemas inside Tool Call** — 5.1b only picks the slug; a mini form driven by `capability.functionDefinition.parameters` is future work.
- **Undo/redo, copy/paste, keyboard shortcuts** — not planned for 5.1 at all.
- **Pattern Explorer** — the palette "Learn more" links forward to `/admin/orchestration/learning/patterns/:n`, which doesn't exist yet. 404 until the Pattern Explorer ships.
- **Execution history page** — list UI at `/admin/orchestration/executions` with status filter, workflowId filter, pagination. Linked from the workflows table "Runs" column.
- **Mid-run resume for non-approval failures** — only `human_approval` resumes cleanly; a dead LLM call leaves the row at its last checkpoint without an automatic replay path.

## Execution panel

Clicking **Execute** in edit mode opens `ExecutionInputDialog` — a JSON textarea seeded with `{ "query": "" }` plus an optional budget input. The dialog also includes a **Dry run** button that calls `POST /api/v1/admin/orchestration/workflows/:id/dry-run` with the same payload. Dry-run validates the input and workflow structure without executing, returning `{ valid, errors?, warnings? }`. Results render inline: a green "Dry run passed" or red "Dry run failed" banner with error/warning lists. On confirm the dialog calls `onExecutionConfirm({ inputData, budgetLimitUsd })` and the builder renders an `ExecutionPanel` in a new 420px column on the right of the canvas.

**Files:**

- `components/admin/orchestration/workflow-builder/execution-panel.tsx` — the sliding panel + SSE consumer
- `components/admin/orchestration/workflow-builder/execution-trace-entry.tsx` — one collapsible row per step
- `components/admin/orchestration/workflow-builder/execution-input-dialog.tsx` — `inputData` collector

`ExecutionPanel` calls `POST /api/v1/admin/orchestration/workflows/:id/execute` with the input body and reads the SSE stream directly via `fetch` + `reader.read()` + a manual `\n\n` split (the same pattern as `agent-test-chat.tsx`). It **cannot** use `EventSource` because that API can't POST a JSON body. Each parsed `ExecutionEvent` drives a reducer over a `LiveTraceEntry[]`:

| Event                | UI effect                                                                               |
| -------------------- | --------------------------------------------------------------------------------------- |
| `workflow_started`   | Captures `executionId`, flips status pill to "Running"                                  |
| `step_started`       | Appends a new trace row with status `running`                                           |
| `step_completed`     | Updates the row with `output`, `tokensUsed`, `costUsd`, `durationMs`; bumps totals      |
| `step_failed`        | Flags the row `failed` (or leaves it `running` when `willRetry: true`)                  |
| `approval_required`  | Flips status to `awaiting_approval` and surfaces the **Approve & continue** button      |
| `budget_warning`     | Renders an amber banner `Used $X of $Y budget (N%)`                                     |
| `workflow_completed` | Terminal — status pill → "Completed"                                                    |
| `workflow_failed`    | Terminal — status pill → "Failed", red banner with the sanitized `error` from the frame |

**Abort / Cancel** — while `status === 'running'` the panel renders an abort button. Clicking it first POSTs to `POST /executions/:id/cancel` (best-effort — the cancel persists `status: 'cancelled'` and `completedAt` in the database) then calls `abortController.abort()`. The engine polls execution status between steps and stops when it sees `cancelled`. Unmounting the panel while a stream is open has the same abort effect via the cleanup function on the `useEffect` that drives `streamRun`.

**Approve** — on `approval_required` the panel enables the Approve button. Clicking it POSTs `{ approvalPayload: { approved: true } }` to `/executions/:id/approve` via `apiClient.post`, then reconnects to the execute route with `?resumeFromExecutionId=<id>` so the engine drains the remaining events. The resume path is covered by the engine docs — see [`../orchestration/engine.md`](../orchestration/engine.md).

**Error sanitization** — the panel never prints the raw `fetch` error from a network failure; it renders a generic `"Connection to the execution stream was lost."` banner. Domain errors yielded by the engine as `workflow_failed` frames are displayed verbatim because those strings come from the engine's own sanitized payload (see [`../api/sse.md`](../api/sse.md#error-sanitization) for the framing guarantee).

## Testing

Unit tests live under `tests/unit/lib/orchestration/engine/` and `tests/unit/components/admin/orchestration/workflow-builder/`. Integration tests live under `tests/integration/app/admin/orchestration/workflows/`.

**Mocking React Flow:** canvas / builder / node tests mock `@xyflow/react` at the module level. The stub module exports trivial replacements for `ReactFlow`, `ReactFlowProvider`, `Handle`, `Background`, `Controls`, `MiniMap`, `useReactFlow`, `useNodesState`, `useEdgesState`, and `addEdge`. Verifies prop wiring without needing to hydrate the real library.

**Mocking the mappers' complement:** `workflow-mappers.ts` is pure TS so its tests need zero mocks — they exercise round-trips directly against fixture definitions.

## Definition version history

In **edit mode**, a collapsible `WorkflowDefinitionHistoryPanel` appears below the validation summary. It follows the same pattern as `InstructionsHistoryPanel` on the agent form.

**Schema:** `AiWorkflow.workflowDefinitionHistory` is a JSON column (`@default("[]")`) storing `[{ definition, changedAt, changedBy }]` entries. Every PATCH that changes `workflowDefinition` pushes the old value onto the array before writing the new one.

**Endpoints:**

- `GET /workflows/:id/definition-history` — returns `{ workflowId, slug, current, history }` with history newest-first, each entry annotated with `versionIndex` (the raw oldest→newest DB array index).
- `POST /workflows/:id/definition-revert` — body `{ versionIndex }`. Pushes the current definition onto history before overwriting with the target version, so the revert itself is auditable.

**UI:** lazy-fetch on first expand, newest-first rows with step count preview, "Diff" dialog (JSON pretty-print LCS diff), "Revert" with AlertDialog confirmation. After a successful revert, the builder re-fetches the workflow and re-initializes the canvas nodes/edges.

**Validation schemas:** `workflowDefinitionHistoryEntrySchema`, `workflowDefinitionHistorySchema`, `workflowDefinitionRevertSchema` in `lib/validations/orchestration.ts`.

## Schedules Tab

The workflow edit page (`/admin/orchestration/workflows/[id]`) includes a `<WorkflowSchedulesTab>` below the builder canvas (separated by an `<hr>`).

**Component:** `components/admin/orchestration/workflow-schedules-tab.tsx`

Features:

- List of schedules with name, cron expression badge, next run time, enabled toggle, delete button
- Empty state with CalendarClock icon
- Create dialog: name, cron expression (with helper text), input template (JSON textarea), enabled toggle
- Toggle enabled/disabled via PATCH
- Delete with AlertDialog confirmation

**API:** Uses `GET/POST /workflows/:id/schedules` and `PATCH/DELETE /workflows/:id/schedules/:scheduleId`.

See [Scheduling & Webhooks](../orchestration/scheduling.md) for the cron format and scheduler service.

## Related

- [.context/orchestration/workflows.md](../orchestration/workflows.md) — the DAG validator, step types, error codes, and HTTP surface the builder reads/writes
- [.context/orchestration/engine.md](../orchestration/engine.md) — runtime execution engine consumed by the Execute button
- [.context/orchestration/admin-api.md](../orchestration/admin-api.md) — the admin API surface for workflows (list / get / create / patch / delete / validate / execute)
- [.context/api/sse.md](../api/sse.md) — the SSE framing contract used by the execute route
- [.context/admin/agent-form.md](./agent-form.md) — reference implementation of the `<FieldHelp>` directive; the builder config panel mirrors its voice
- [.context/ui/contextual-help.md](../ui/contextual-help.md) — contextual-help directive and help-text pattern
- `lib/orchestration/workflows/validator.ts` — the validator the 5.1b Validate button calls
- `lib/orchestration/engine/orchestration-engine.ts` — the engine the Execute button streams against
