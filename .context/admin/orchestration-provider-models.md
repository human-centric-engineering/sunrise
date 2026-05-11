# Provider Models admin UI

Admin surface for the `AiProviderModel` registry — the per-model intelligence table (tier classification, reasoning depth, latency, embedding capability) that sits alongside operational `AiProviderConfig` records. For the data model, seed strategy, and library-side selector, see [Provider Selection Matrix](../orchestration/provider-selection-matrix.md).

## Where it lives

```
/admin/orchestration/provider-models           ──307──►  /admin/orchestration/providers?tab=models
/admin/orchestration/provider-models/new       ──307──►  /admin/orchestration/providers?tab=models
/admin/orchestration/provider-models/[id]      → standalone edit page
```

The list surface lives as the **Models tab** on the Providers page (`app/admin/orchestration/providers/page.tsx`). The legacy `/provider-models` route redirects there to keep older links working. The matrix table, filters, and decision heuristic all render inside that tab via `<ProviderModelsMatrix />`.

Creation now goes through the discovery dialog (see "Adding models" below); the legacy `/provider-models/new` page just redirects to the matrix tab so stale bookmarks bounce to the new entry point. The **[id]** sub-route is still a standalone server shell that mounts `<ProviderModelForm />` for editing.

## Capability surface

The matrix and the live catalogue (View Models panel) speak slightly different capability vocabularies. Knowing which is which avoids surprise when a model that's clearly listed in the catalogue refuses to land in the matrix.

| Capability   | Matrix?          | Catalogue? | Engine path                                                                                                                   |
| ------------ | ---------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `chat`       | ✓                | ✓          | `provider.chat()` — workhorse                                                                                                 |
| `reasoning`  | ✓                | ✓          | `provider.chat()` (badge distinguishes cost/latency tier). `/v1/responses` reasoning models still run through `chat()` today. |
| `embedding`  | ✓                | ✓          | `provider.embed()`                                                                                                            |
| `audio`      | ✓                | ✓          | `provider.transcribe?()` resolved via `getAudioProvider()` in `lib/orchestration/llm/provider-manager.ts`                     |
| `image`      | ✓ (storage-only) | ✓          | None — UI surfaces "Storage-only" indicator                                                                                   |
| `moderation` | ✓ (storage-only) | ✓          | None — UI surfaces "Storage-only" indicator                                                                                   |
| `unknown`    | ✗                | ✓          | None — discovery-only placeholder; matrix Zod schema rejects it                                                               |

Canonical definitions live in `types/orchestration.ts` (`MODEL_CAPABILITIES`, `STORAGE_ONLY_CAPABILITIES`). The catalogue's `Capability` union is the strict superset (adds `unknown`).

## Matrix view

`components/admin/orchestration/provider-models-matrix.tsx` — the client island rendered inside the Models tab.

### Filters

- **Provider** — Radix `<Select>` seeded with distinct `providerSlug` values from the result set, plus "All providers".
- **Tier** — all 6 `TIER_ROLE_META` entries (Thinking, Worker, Infrastructure, Control Plane, Local/Sovereign, Embedding).
- **Search** — substring match across `name`, `modelId`, `slug`, `bestRole`.
- **Capability chips** — multi-select chips, one per matrix-storable capability: `Chat` · `Reasoning` · `Embedding` · `Audio` · `Image` · `Moderation`. OR semantics across chips. `Unknown` is **not** offered here — it's catalogue-only.
- **Has agent** — toggle chip that hides rows with no directly-assigned agents (filters by `agents?.length > 0`). Rows that serve only as a default-settings fallback are also hidden — the filter matches the column it shares semantics with.

### Columns

| Column                                       | Source                                   | Notes                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider                                     | `model.providerSlug`                     | Sortable header                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Name                                         | `model.name`                             | Sortable; links to edit page. `Custom` badge when `!isDefault`                                                                                                                                                                                                                                                                                                                                                                                                     |
| Tier Role                                    | `model.tierRole`                         | Sortable; rendered via `TIER_ROLE_META[tierRole].label`                                                                                                                                                                                                                                                                                                                                                                                                            |
| Capabilities                                 | `model.capabilities[]`                   | One pill per stored capability (`Chat` / `Reasoning` / `Embedding` / `Audio` / `Image` / `Moderation`). Rows whose only capabilities are image/moderation render a muted `Storage-only` indicator — the orchestration engine does not invoke those capabilities at runtime.                                                                                                                                                                                        |
| Reasoning / Latency / Cost / Context / Tools | 5 rating columns                         | All sortable, display enum labels                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Configured                                   | derived from matching `AiProviderConfig` | Dot: green = configured + active, yellow = configured + inactive, grey = not configured                                                                                                                                                                                                                                                                                                                                                                            |
| Used by                                      | `model.agents[]` + `model.defaultFor[]`  | Two paths surfaced in one cell: (1) count of agents that directly named this model in their Provider/Model fields (click → popover with names + links); (2) `Default: {TaskType}` badges for any routing/chat/reasoning/embeddings slot this model fills via `AiOrchestrationSettings.defaultModels`. Empty state renders `Not in use` italic so the cell never reads as a bare `0`. Default badges link to `/admin/orchestration/settings` for one-click editing. |

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

### "Discover models" button

Header action opens the **discovery dialog** (`components/admin/orchestration/discover-models-dialog.tsx`) — see [Adding models](#adding-models). The legacy `/provider-models/new` standalone form is gone; operators no longer type `providerSlug`, `modelId`, or any of the six rating enums by hand.

## Adding models

Three-step dialog mounted by the matrix list page's **Discover models** button. Reused from the View Models panel's "Add to matrix" affordance (see [orchestration-providers.md](./orchestration-providers.md)).

### Step 1 — Provider

Radix `<Select>` populated from active `AiProviderConfig` rows (`GET /providers?isActive=true`). No free-text — fixes the legacy form's central weakness where typo'd `providerSlug` values silently created orphan matrix rows.

When the dialog is opened with a `providerSlug` prop (View Models panel reuse), step 1 is skipped entirely.

### Step 2 — Discovery

Fires `GET /api/v1/admin/orchestration/discovery/models?providerSlug=<slug>` on entry. The route fans out across two sources in parallel:

- **Vendor SDK** — `provider.listModels()` for the configured provider. Returns whatever the vendor's `/v1/models` endpoint reports.
- **OpenRouter** — the cached catalogue from `lib/orchestration/llm/model-registry.ts:refreshFromOpenRouter` (24-hour TTL). Filters to entries whose OpenRouter prefix matches the requested provider.

Either tier can fail silently — the route only 503s when both are unavailable. Anthropic's SDK only ships 3 hardcoded models, so OpenRouter is the path to surface the rest of the family.

Each candidate is annotated:

| Field                | Meaning                                                                                                                                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sources`            | `{ vendor: boolean, openrouter: boolean }` — drives the source dots in the table so operators can spot OpenRouter-only suggestions                                                                             |
| `inMatrix`           | `true` when an **active** matrix row exists for `(providerSlug, modelId)`. Filters by `isActive: true` to match the View Models panel — soft-deleted rows fall through and the operator can re-attempt the add |
| `matrixId`           | The active matrix row's id when present, else `null`                                                                                                                                                           |
| `inferredCapability` | From `lib/orchestration/llm/capability-inference.ts` — `chat` / `reasoning` / `embedding` / `image` / `audio` / `moderation` / `unknown`                                                                       |
| `suggested`          | Heuristic-derived defaults for every matrix field (see "Heuristics" below)                                                                                                                                     |

Filter chips and search match the View Models panel's pattern — one chip per `Capability` value (`Chat`, `Reasoning`, `Embedding`, `Image`, `Audio`, `Moderation`, `Unknown`) with substring search on id + name. Pre-Phase-5 the dialog and panel collapsed reasoning + moderation + unknown into a single `Other` chip; each now has its own.

### Step 3 — Review

Expandable card per selected candidate with the heuristic-derived metadata as editable form controls (name, description, capability checkboxes, tierRole select, the five rating selects, bestRole text). Each card has a **Reset to suggestion** link that rolls back operator edits to the discovery defaults.

Embedding-specific fields (`dimensions`, `schemaCompatible`, `costPerMillionTokens`, `hasFreeTier`, `quality`, `strengths`, `setup`) are **not** in the dialog UI — operators can edit them via the legacy `/provider-models/[id]` edit form after creation. Keeps the review step tractable.

### Submit + result

`POST /api/v1/admin/orchestration/provider-models/bulk` with the envelope `{ providerSlug, models: [...] }`. Server uses `prisma.aiProviderModel.createMany({ data, skipDuplicates: true })` and returns:

```jsonc
{
  "created": number,
  "skipped": number,
  "conflicts": [
    { "modelId": "gpt-4o", "reason": "already_in_matrix" },
    { "modelId": "gpt-4o-mini", "reason": "already_in_matrix_inactive" }, // soft-deleted; operator should reactivate
  ]
}
```

The result panel renders active conflicts and inactive conflicts under separate headings — `already_in_matrix_inactive` rows can't be re-added through discovery (the unique constraint blocks it), so the operator is pointed at the matrix list to flip `isActive` back on.

### Heuristics

`lib/orchestration/llm/model-heuristics.ts` — pure functions (no I/O) that map raw signals to the matrix's enum fields:

| Function               | Output                                                   | Driven by                                                                                                                                           |
| ---------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `deriveCostEfficiency` | `very_high` / `high` / `medium` / `none`                 | `inputCostPerMillion` thresholds (≤$0.5 / ≤$2 / ≤$10 / >$10)                                                                                        |
| `deriveContextLength`  | `very_high` / `high` / `medium` / `n_a`                  | `maxContext` (≥1M / ≥128K / ≥32K / else)                                                                                                            |
| `deriveLatency`        | `very_fast` / `fast` / `medium`                          | id contains `nano` / `flash-lite` → very_fast; `mini` / `flash` / `haiku` / `turbo` → fast                                                          |
| `deriveReasoningDepth` | `very_high` / `high` / `medium` / `none`                 | `opus` / `o1` / `o3` / `o4` → very_high; `gpt-4` / `gpt-5` / `sonnet` / `gemini-pro` → high; cheap variants → medium                                |
| `deriveTierRole`       | one of the 6 `TIER_ROLES`                                | embedding capability → `embedding`; local → `local_sovereign`; reasoning_depth=very_high → `thinking`; cheap+fast → `worker`; else `infrastructure` |
| `deriveToolUse`        | `strong` / `moderate` / `none`                           | OpenRouter's `supported_parameters` array                                                                                                           |
| `deriveBestRole`       | Short canned phrase per `(tier, capability)` combination | Lookup table                                                                                                                                        |
| `deriveMatrixSlug`     | `${providerSlug}-${modelId}` lowercased + hyphenated     | Matches the legacy form's `toSlug()` rule                                                                                                           |

Word-boundary regex on cheap-variant matchers — `gemini-pro` doesn't accidentally downgrade itself for containing the substring `mini`. Frontier-reasoning families take precedence over the cheap-variant downgrade so `o1-mini` stays `very_high`.

## Form (edit only)

`components/admin/orchestration/provider-model-form.tsx` — `react-hook-form` + `zodResolver`. Top of the form is a sticky action bar with Cancel / Save. Only mounted on the `[id]` edit page now — creation goes through the discovery dialog described above.

### Seed-managed warning

The edit page checks `model.isDefault`. When `true`, an amber banner warns:

> This is a seed-managed model — editing it will make it admin-managed.

Any PATCH flips `isDefault` to `false` server-side so re-seeds leave the row alone afterwards.

### Fields

| Field           | Rule                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Provider Slug   | Required; matches `AiProviderConfig.slug` for the configured-status dot to light up                                                                                                                                                                                                                                                                                                        |
| Model ID        | Required; the API identifier sent to the provider (e.g. `gpt-5`)                                                                                                                                                                                                                                                                                                                           |
| Display Name    | Required, ≤ 100 chars                                                                                                                                                                                                                                                                                                                                                                      |
| Slug            | Required, lowercased with hyphens; disabled in edit mode. Auto-derived from `providerSlug + name` in create mode unless the admin types it manually                                                                                                                                                                                                                                        |
| Description     | Required, ≤ 2000 chars                                                                                                                                                                                                                                                                                                                                                                     |
| Capabilities    | Six checkboxes: Chat · Reasoning · Embedding · Audio · Image · Moderation. At least one required (Zod refinement). Each checkbox has a `FieldHelp`. Selecting only `Image` and/or `Moderation` surfaces a muted "Storage-only" note — the orchestration engine does not invoke those capabilities at runtime, so the row appears in audits/inventory but cannot serve an agent at runtime. |
| Tier Role       | Radix `<Select>` populated from `TIER_ROLE_META`; label shows `{label} — {description}`                                                                                                                                                                                                                                                                                                    |
| Reasoning Depth | `very_high` · `high` · `medium` · `none`                                                                                                                                                                                                                                                                                                                                                   |
| Latency         | `very_fast` · `fast` · `medium`                                                                                                                                                                                                                                                                                                                                                            |
| Cost Efficiency | `very_high` · `high` · `medium` · `none`                                                                                                                                                                                                                                                                                                                                                   |
| Context Length  | `very_high` · `high` · `medium` · `n_a`                                                                                                                                                                                                                                                                                                                                                    |
| Tool Use        | `strong` · `moderate` · `none`                                                                                                                                                                                                                                                                                                                                                             |
| Best Role       | Free-text one-liner (e.g. "Planner / orchestrator")                                                                                                                                                                                                                                                                                                                                        |
| Active          | `<Switch>`. Inactive models are hidden from the matrix and `recommend` endpoint                                                                                                                                                                                                                                                                                                            |

### Embedding-only fields

Rendered in a bordered "Embedding Details" block that only appears when the Embedding capability is checked (the form watches `capabilities.includes('embedding')`):

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
- The submit handler sends `capabilities[]` directly from the checkbox state and parses numeric strings (`dimensions`, `costPerMillionTokens`) before POST. In create mode, embedding fields are omitted when `embedding` is not in the array. In edit mode, removing `embedding` from the array explicitly nulls all embedding fields (`dimensions`, `schemaCompatible`, `costPerMillionTokens`, `hasFreeTier`, `quality`, `strengths`, `setup`) so stale values are cleared from the database.
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
