# Provider Models admin UI

Admin surface for the `AiProviderModel` registry — the per-model intelligence table (tier classification, reasoning depth, latency, embedding capability) that sits alongside operational `AiProviderConfig` records. For the data model, seed strategy, and library-side selector, see [Provider Selection Matrix](../orchestration/provider-selection-matrix.md).

## Where it lives

```
/admin/orchestration/provider-models           ──307──►  /admin/orchestration/providers?tab=models
/admin/orchestration/provider-models/new       → standalone create page
/admin/orchestration/provider-models/[id]      → standalone edit page
```

The list surface lives as the **Models tab** on the Providers page (`app/admin/orchestration/providers/page.tsx`). The legacy `/provider-models` route redirects there to keep older links working. The matrix table, filters, and decision heuristic all render inside that tab via `<ProviderModelsMatrix />`.

The **new** and **[id]** sub-routes are still standalone server shells — breadcrumb reads `AI Orchestration / Provider Models / New` (or `/ <model.name>`).

## Matrix view

`components/admin/orchestration/provider-models-matrix.tsx` — the client island rendered inside the Models tab.

### Filters

- **Provider** — Radix `<Select>` seeded with distinct `providerSlug` values from the result set, plus "All providers".
- **Tier** — all 6 `TIER_ROLE_META` entries (Thinking, Worker, Infrastructure, Control Plane, Local/Sovereign, Embedding).
- **Capability** — `All types` · `Chat` · `Embedding`.

### Columns

| Column                                       | Source                                   | Notes                                                                                   |
| -------------------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------------- |
| Provider                                     | `model.providerSlug`                     | Sortable header                                                                         |
| Name                                         | `model.name`                             | Sortable; links to edit page. `Custom` badge when `!isDefault`                          |
| Tier Role                                    | `model.tierRole`                         | Sortable; rendered via `TIER_ROLE_META[tierRole].label`                                 |
| Capabilities                                 | `model.capabilities[]`                   | Badges: `Chat`, `Embedding`, or `Both`                                                  |
| Reasoning / Latency / Cost / Context / Tools | 5 rating columns                         | All sortable, display enum labels                                                       |
| Configured                                   | derived from matching `AiProviderConfig` | Dot: green = configured + active, yellow = configured + inactive, grey = not configured |

### Sort

Header clicks toggle `sortKey` (one of: `providerSlug`, `name`, `tierRole`, `reasoningDepth`, `latency`, `costEfficiency`, `contextLength`, `toolUse`) and `sortAsc` (boolean). Sort is client-side over the current result set.

### Decision heuristic table

Rendered inline beneath the matrix. Six rows mapping task intent → recommended tier:

| Intent             | Recommended Tier  |
| ------------------ | ----------------- |
| `thinking`         | Thinking          |
| `doing`            | Worker            |
| `fast_looping`     | Infrastructure    |
| `high_reliability` | Control Plane     |
| `private`          | Local / Sovereign |
| `embedding`        | Embedding         |

Hardcoded in the component — maps each intent to a tier, task characteristics, and rationale. The `recommend` endpoint exists as a separate API but is not used by the rendered table.

### "Add model" button

Header action links to `/admin/orchestration/provider-models/new`.

## Form (create & edit)

`components/admin/orchestration/provider-model-form.tsx` — `react-hook-form` + `zodResolver`. Top of the form is a sticky action bar with Cancel / Save.

### Seed-managed warning

The edit page checks `model.isDefault`. When `true`, an amber banner warns:

> This is a seed-managed model — editing it will make it admin-managed.

Any PATCH flips `isDefault` to `false` server-side so re-seeds leave the row alone afterwards.

### Fields

| Field           | Rule                                                                                                                                                |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider Slug   | Required; matches `AiProviderConfig.slug` for the configured-status dot to light up                                                                 |
| Model ID        | Required; the API identifier sent to the provider (e.g. `gpt-5`)                                                                                    |
| Display Name    | Required, ≤ 100 chars                                                                                                                               |
| Slug            | Required, lowercased with hyphens; disabled in edit mode. Auto-derived from `providerSlug + name` in create mode unless the admin types it manually |
| Description     | Required, ≤ 2000 chars                                                                                                                              |
| Capabilities    | Two checkboxes: Chat · Embedding. At least one required (enforced client-side before POST)                                                          |
| Tier Role       | Radix `<Select>` populated from `TIER_ROLE_META`; label shows `{label} — {description}`                                                             |
| Reasoning Depth | `very_high` · `high` · `medium` · `none`                                                                                                            |
| Latency         | `very_fast` · `fast` · `medium`                                                                                                                     |
| Cost Efficiency | `very_high` · `high` · `medium` · `none`                                                                                                            |
| Context Length  | `very_high` · `high` · `medium` · `n_a`                                                                                                             |
| Tool Use        | `strong` · `moderate` · `none`                                                                                                                      |
| Best Role       | Free-text one-liner (e.g. "Planner / orchestrator")                                                                                                 |
| Active          | `<Switch>`. Inactive models are hidden from the matrix and `recommend` endpoint                                                                     |

### Embedding-only fields

Rendered in a bordered "Embedding Details" block that only appears when `capEmbedding` is checked:

| Field               | Notes                                                                       |
| ------------------- | --------------------------------------------------------------------------- |
| Dimensions          | Native output vector size (e.g. 1536, 1024, 768)                            |
| Cost / 1M Tokens    | USD, floating point                                                         |
| Schema Compatible   | Checkbox — can the model produce 1536-dim vectors compatible with pgvector? |
| Free Tier           | Checkbox                                                                    |
| Local / Self-hosted | Checkbox                                                                    |
| Quality             | `high` · `medium` · `budget`                                                |
| Strengths           | Free-text description                                                       |
| Setup               | Short setup hint (e.g. "API key → add as provider")                         |

The embedding block feeds the "Compare Embedding Providers" modal on the Knowledge Base page, so fields like Dimensions, Schema Compatible, and Cost are visible to admins comparing embedding options.

### Submit behaviour

- Validation errors surface inline below each field (`errors.{name}.message`).
- The submit handler assembles `capabilities[]` from the two checkboxes and parses numeric strings (`dimensions`, `costPerMillionTokens`) before POST. In create mode, embedding fields are omitted when `capEmbedding` is off. In edit mode, unchecking `capEmbedding` explicitly nulls all embedding fields (`dimensions`, `schemaCompatible`, `costPerMillionTokens`, `hasFreeTier`, `quality`, `strengths`, `setup`) so stale values are cleared from the database.
- Create: `POST /api/v1/admin/orchestration/provider-models` → router pushes to the new model's edit page with a success banner.
- Edit: `PATCH /api/v1/admin/orchestration/provider-models/:id` → inline "Saved" flash for 2s.
- Most fields have a `<FieldHelp>` popover per the contextual-help rule. Fields with FieldHelp: Provider Slug, Model ID, Slug, Capabilities, Tier Role, Best Role, Dimensions, Schema Compatible, and all five rating dimensions (Reasoning Depth, Latency, Cost Efficiency, Context Length, Tool Use). Remaining embedding fields (Cost/1M Tokens, Free Tier, Local/Self-hosted, Quality, Strengths, Setup) also have FieldHelp.

## Recommend endpoint

```
GET /api/v1/admin/orchestration/provider-models/recommend?intent=<intent>
Authorization: Admin
```

`intent` ∈ `thinking` · `doing` · `fast_looping` · `high_reliability` · `private` · `embedding`.

Response:

```jsonc
{
  "intent": "thinking",
  "recommendations": [
    { "slug": "...", "providerSlug": "...", "score": 90, "reason": "..." },
    // ...
  ],
  "heuristic": {
    "thinking": "If it thinks → use frontier models (Tier 1)",
    "doing": "If it does → use cheap/open models (Tier 2)",
    "fast_looping": "If it loops fast → use infra providers (Tier 3)",
    "high_reliability": "If it must not fail → route via aggregators (Tier 4)",
    "private": "If it must stay private → run local (Tier 5)",
    "embedding": "If it needs vector embeddings → use embedding models",
  },
}
```

Powered by `recommendModels()` in `lib/orchestration/llm/provider-selector.ts`.

## Model Audit Workflow

The matrix toolbar includes an **Audit Models** button that triggers the Provider Model Audit workflow — an AI-powered evaluation of model entries for accuracy and freshness.

### What it does

1. Admin selects models to audit via a checkbox dialog (filter by provider, select all/deselect all)
2. On submit, the dialog creates a workflow execution via `POST /workflows/:id/execute` with selected model data as `inputData`
3. The browser redirects to the execution detail page where SSE streaming shows real-time progress
4. The workflow analyses each model's tier classification, capability ratings, and metadata using LLM evaluation
5. A `human_approval` step pauses execution and presents proposed changes for admin review
6. On approval, the `apply_audit_changes` capability writes accepted changes, `add_provider_models` adds newly discovered models, and `deactivate_provider_models` soft-deletes deprecated ones — all invalidate the model cache

### Audit frequency

Models evolve quickly but don't need obsessive re-auditing. A reasonable cadence is once every few months, or when you notice a classification inaccuracy (e.g. a model's tier, reasoning depth, or cost rating seems wrong). The audit dialog shows when each model was last audited to help you prioritise.

### Components

| Component         | File                                                                    |
| ----------------- | ----------------------------------------------------------------------- |
| Trigger dialog    | `components/admin/orchestration/audit-models-dialog.tsx`                |
| Button in matrix  | `components/admin/orchestration/provider-models-matrix.tsx`             |
| Workflow template | `prisma/seeds/data/templates/provider-model-audit.ts`                   |
| Apply changes cap | `lib/orchestration/capabilities/built-in/apply-audit-changes.ts`        |
| Add models cap    | `lib/orchestration/capabilities/built-in/add-provider-models.ts`        |
| Deactivate cap    | `lib/orchestration/capabilities/built-in/deactivate-provider-models.ts` |
| Agent seed        | `prisma/seeds/010-model-auditor.ts`                                     |

### Framework reference implementation

This feature also serves as a reference implementation for the orchestration framework, exercising 10 of the 15 step types end-to-end: `llm_call`, `rag_retrieve`, `route`, `parallel`, `guard`, `reflect`, `evaluate`, `human_approval`, `tool_call`, and `send_notification`. FieldHelp annotations in the dialog explain which framework capability each element tests. See [Provider Selection Matrix — Model Audit Workflow](../orchestration/provider-selection-matrix.md#model-audit-workflow) for the full step-type breakdown.

## Related

- [Provider Selection Matrix](../orchestration/provider-selection-matrix.md) — data model, 6-tier classification, `recommendModels()` library API
- [Providers list](./orchestration-providers.md) — the Models tab is embedded here
- [LLM providers (runtime)](../orchestration/llm-providers.md) — runtime provider abstraction
- [Knowledge Base UI](./orchestration-knowledge-ui.md) — consumes the embedding-model entries for the comparison modal
