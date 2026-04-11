# Workflow builder

Visual editor for `AiWorkflow` definitions. Drag pattern blocks from a left-hand palette onto a React Flow canvas, connect handles to build a DAG, click a block to edit it in the right-hand panel. Landed in Phase 5 Session 5.1a.

**Status:** Canvas + palette + custom nodes + selection → config-panel **shell**. Save / Validate / Execute toolbar buttons are rendered but disabled — wiring arrives in Session 5.1b.

**Core files:**

- `app/admin/orchestration/workflows/page.tsx` — list (server shell)
- `app/admin/orchestration/workflows/new/page.tsx` — create (server shell)
- `app/admin/orchestration/workflows/[id]/page.tsx` — edit (server shell, `notFound()` on 404)
- `components/admin/orchestration/workflow-builder/` — all builder client islands
- `components/admin/orchestration/workflows-table.tsx` — list page client island
- `lib/orchestration/engine/step-registry.ts` — single source of truth for pattern step metadata

**Dependency:** `@xyflow/react` (React Flow 12). First React Flow usage in the repo; the canvas / node-type / handle patterns established here will be reused by any future diagram UI.

## Pages

| Route                                 | File                                              | Purpose                                         |
| ------------------------------------- | ------------------------------------------------- | ----------------------------------------------- |
| `/admin/orchestration/workflows`      | `app/admin/orchestration/workflows/page.tsx`      | List, search, pagination, active toggle, delete |
| `/admin/orchestration/workflows/new`  | `app/admin/orchestration/workflows/new/page.tsx`  | Empty builder — create mode                     |
| `/admin/orchestration/workflows/[id]` | `app/admin/orchestration/workflows/[id]/page.tsx` | Hydrated builder — edit mode                    |

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

When nothing is selected the right column collapses. The toolbar's disabled action buttons carry a native `title="Available in Session 5.1b"` tooltip.

## Step registry

`lib/orchestration/engine/step-registry.ts` is the data-driven source of truth for pattern step types. The palette iterates over `STEP_REGISTRY` and renders one draggable block per entry; the `PatternNode` custom node looks entries up by `type` for its icon, colour, and handle counts.

**Entry shape:**

```ts
interface StepRegistryEntry {
  type: WorkflowStepType;
  label: string;
  description: string;
  category: 'agent' | 'decision' | 'input' | 'output';
  icon: LucideIcon;
  inputs: number; // handle count on target side
  outputs: number; // handle count on source side (route: 2, parallel: 3, rest: 1)
  patternNumber?: number; // forward-link to /learning/patterns/:n
  defaultConfig: Record<string, unknown>;
}
```

**Initial nine entries** (Session 5.1a):

| Type             | Label          | Category | Outputs | Pattern |
| ---------------- | -------------- | -------- | ------- | ------- |
| `llm_call`       | LLM Call       | agent    | 1       | 1       |
| `chain`          | Chain Step     | agent    | 1       | 2       |
| `route`          | Route          | decision | 2       | 3       |
| `parallel`       | Parallel       | output   | 3       | 4       |
| `reflect`        | Reflect        | agent    | 1       | 5       |
| `tool_call`      | Tool Call      | input    | 1       | 6       |
| `plan`           | Plan           | agent    | 1       | 7       |
| `human_approval` | Human Approval | decision | 1       | 8       |
| `rag_retrieve`   | RAG Retrieve   | input    | 1       | 9       |

**Adding a new step type:** append an entry to `STEP_REGISTRY`. The palette, the `PatternNode`, and any future registry-driven consumer will pick it up automatically — no new component, no new JSX.

**FE/BE split:** this registry is FE-only in Session 5.1a. The backend validator (`lib/orchestration/workflows/validator.ts`) keeps its own `KNOWN_STEP_TYPES` array for now. Session 5.2 will unify them when it wires the workflow engine executor.

### Category → colour map

All four categories have a matching entry in `STEP_CATEGORY_COLOURS` driving the node and palette chip Tailwind classes:

| Category   | Tailwind palette                                              | Intent                             |
| ---------- | ------------------------------------------------------------- | ---------------------------------- |
| `agent`    | blue (`bg-blue-50` / `border-blue-300` / `text-blue-900`)     | LLM-facing work                    |
| `decision` | amber (`bg-amber-50` / `border-amber-300` / `text-amber-900`) | Branching or human-gated decisions |
| `input`    | slate (`bg-slate-50` / `border-slate-300` / `text-slate-900`) | Inputs and retrieval               |
| `output`   | emerald (`bg-emerald-50` / `border-emerald-300` / `text-…`)   | Fan-out / join steps               |

## Custom node type

`components/admin/orchestration/workflow-builder/node-types/pattern-node.tsx` is **one** React Flow custom node used for every pattern step. It reads `data.type` and looks up the registry entry for its visual treatment — icon, category colour, and handle count.

- `inputs === 1`: one target handle stacked at the vertical midpoint.
- `outputs === 2` (`route`): two source handles at 33% and 67% vertical.
- `outputs === 3` (`parallel`): three source handles at 25% / 50% / 75%.
- `selected === true`: node root gets `ring-2 ring-primary shadow-md`.

`nodeTypes` is exported as a frozen module-scope object from `node-types/index.ts` — this is the React Flow recommended pattern and prevents unnecessary re-renders of custom node components.

## Canvas interactions

| Action                     | Effect                                                                        |
| -------------------------- | ----------------------------------------------------------------------------- |
| Drag palette block         | HTML5 DnD — `dataTransfer.setData('application/reactflow', type)`             |
| Drop on canvas             | `onDrop` reads the type, **validates** against the registry, then `addNode()` |
| Drag from output handle    | React Flow `onConnect` → `addEdge({ ...connection, type: 'default' }, edges)` |
| Click a node               | `setSelectedNodeId(id)` → right panel opens                                   |
| Click the pane             | `setSelectedNodeId(null)` → right panel closes                                |
| Delete button (right pane) | Removes the node and every edge that references it                            |
| Scroll / pinch / pan       | Native React Flow (Controls + MiniMap included)                               |

**Snap to grid:** `snapToGrid` is on with `snapGrid={[16, 16]}`. Keeps casually-placed nodes visually aligned.

**Drop payload validation:** `onDrop` rejects any `application/reactflow` value that isn't in `STEP_REGISTRY` — a defensive check so we never materialise a node from an unknown string (security-review note).

## Config panel

Session 5.1a shell only:

- Read-only type badge (category colour + icon + label).
- Editable **Name** `<Input>` with `<FieldHelp title="Step name">`. Writes back via `onLabelChange(id, value)`, which updates `data.label` on the selected node.
- Read-only **Step ID** with a copy-to-clipboard button. IDs are generated via `makeStepId()` (`step_<random8>`) and never change.
- Read-only **Configuration** — `<pre>{JSON.stringify(data.config, null, 2)}</pre>`. A `<FieldHelp>` notes that per-step-type editors (prompt, routes, capability slug, etc.) land in Session 5.1b.
- **Delete** button at the top of the panel — removes the node and its incident edges, clears the selection.

## Layout persistence

The builder round-trips the stored `WorkflowDefinition` JSON through React Flow via `components/admin/orchestration/workflow-builder/workflow-mappers.ts`:

- **`workflowDefinitionToFlow(def)`** — turns each `WorkflowStep` into a `PatternNode`. Position: if `step.config._layout = { x, y }` exists, use it verbatim; otherwise run a simple BFS levelling from `entryStepId` (`x = level * 260`, `y = idxInLevel * 140`). One edge per `ConditionalEdge`; `condition` string becomes the edge label.
- **`flowToWorkflowDefinition(nodes, edges, opts)`** — inverse. Stashes each node's `x/y` back into `step.config._layout` on save. Strips any pre-existing `_layout` first so layouts don't nest on re-save. Derives `entryStepId` as the first node with no incoming edge (fallback: first node in the list).

**Why `_layout` in config?** `WorkflowStep.config` is `Record<string, unknown>` on the type side and a JSON column at the Prisma level — no schema change needed. The leading underscore signals "internal/UI metadata" to any future backend consumer (the validator already ignores unknown config keys).

The mapper module is **pure TypeScript** — no React / React Flow imports. It's unit-tested in isolation without DOM setup.

## Scope

Session 5.1a **ships:**

- Three pages reachable from the sidebar.
- Full list table with search, pagination, active switch, delete.
- Empty builder on `/new`.
- Hydrated builder on `/[id]` from the stored `WorkflowDefinition`, including layout.
- Drag from palette, drop, snap-to-grid, connect handles, click-to-select, rename, delete.
- Read-only view of each step's current configuration.

Session 5.1a **defers:**

- **Save** — button disabled. Wiring (POST/PATCH against `/api/v1/admin/orchestration/workflows[/:id]`) lands in 5.1b.
- **Validate** — button disabled. Session 5.1b fires `POST /validate` and decorates offending nodes/edges with error markers.
- **Execute** — button disabled. Real executor + SSE-streamed trace land in Session 5.2.
- **Per-step-type config editors** — prompt/route/capability/etc. forms in the right panel. Session 5.1b.
- **Templates dropdown** — currently a stub with a single disabled menu item. Session 5.1c loads real `isTemplate: true` workflows from the list endpoint.
- **Undo/redo, copy/paste, keyboard shortcuts** — not planned for 5.1 at all.
- **Inline edge condition editor** — click edge → condition textarea. Future work.
- **Pattern Explorer** — the palette "Learn more" links forward to `/admin/orchestration/learning/patterns/:n`, which doesn't exist yet. 404 until the Pattern Explorer ships.

## Testing

Unit tests live under `tests/unit/lib/orchestration/engine/` and `tests/unit/components/admin/orchestration/workflow-builder/`. Integration tests live under `tests/integration/app/admin/orchestration/workflows/`.

**Mocking React Flow:** canvas / builder / node tests mock `@xyflow/react` at the module level. The stub module exports trivial replacements for `ReactFlow`, `ReactFlowProvider`, `Handle`, `Background`, `Controls`, `MiniMap`, `useReactFlow`, `useNodesState`, `useEdgesState`, and `addEdge`. Verifies prop wiring without needing to hydrate the real library.

**Mocking the mappers' complement:** `workflow-mappers.ts` is pure TS so its tests need zero mocks — they exercise round-trips directly against fixture definitions.

## Related

- [.context/orchestration/workflows.md](../orchestration/workflows.md) — the DAG validator, step types, error codes, and HTTP surface the builder reads/writes
- [.context/orchestration/admin-api.md](../orchestration/admin-api.md) — the admin API surface for workflows (list / get / create / patch / delete / validate / execute)
- [.context/admin/agent-form.md](./agent-form.md) — reference implementation of the `<FieldHelp>` directive; the builder config panel mirrors its voice
- [.context/ui/contextual-help.md](../ui/contextual-help.md) — contextual-help directive and help-text pattern
- `lib/orchestration/workflows/validator.ts` — the validator the 5.1b Validate button will call
