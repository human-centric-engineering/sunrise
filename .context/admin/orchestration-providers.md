# Provider management pages

Admin list/create/edit flows for `AiProviderConfig`. Landed in Phase 4 Session 4.3. Providers are the **LLM backends** your agents can call — Anthropic, OpenAI, Voyage AI, Ollama, or any OpenAI-compatible service.

## No pre-seeded providers

A fresh install (post `db:reset`) starts with **zero `AiProviderConfig` rows**. Providers are not pre-seeded — operators choose what to configure via the [setup wizard](./setup-wizard.md), which detects API keys present in `process.env` and offers one-click configuration cards.

The 47-row provider-model matrix (`prisma/seeds/009-provider-models.ts`) is still seeded as **reference catalogue data**, not as configured providers. It powers the Model Matrix tab and the recommender (`lib/orchestration/llm/provider-selector.ts`).

## Detection API

`GET /api/v1/admin/orchestration/providers/detect` (admin-only) scans `process.env` for known LLM API keys and returns:

```ts
{
  detected: Array<{
    slug: string; // e.g. "anthropic"
    name: string;
    providerType: 'anthropic' | 'openai-compatible' | 'voyage';
    defaultBaseUrl: string | null;
    apiKeyEnvVar: string | null; // e.g. "ANTHROPIC_API_KEY" — name only, never the value
    apiKeyPresent: boolean;
    alreadyConfigured: boolean; // true if a row with this slug already exists
    isLocal: boolean;
    suggestedDefaultChatModel: string | null;
    suggestedEmbeddingModel: string | null;
  }>;
}
```

The known-provider catalogue lives in `lib/orchestration/llm/known-providers.ts`. Add a flavour there to make it detectable. Env-var values never leave the server.

**Pages**

| Route                                 | File                                              | Role                                 |
| ------------------------------------- | ------------------------------------------------- | ------------------------------------ |
| `/admin/orchestration/providers`      | `app/admin/orchestration/providers/page.tsx`      | Card grid, status dots, model dialog |
| `/admin/orchestration/providers/new`  | `app/admin/orchestration/providers/new/page.tsx`  | Create shell                         |
| `/admin/orchestration/providers/[id]` | `app/admin/orchestration/providers/[id]/page.tsx` | Edit shell, `notFound()` on missing  |

All three are async server components via `serverFetch()` + `parseApiResponse()`. Fetch failures fall back to an empty grid and are logged with `logger.error`.

## List page — cards, not a table

Providers are few (typically ≤ 6) and have distinctive state (status dot, `Local` badge, model count) that reads better as cards than a table row. The layout gives the test-connection button room to breathe.

```
┌──────────────────────────────────────────────────────────────┐
│ Providers                                   [+ Add Provider] │
├──────────────────────────────────────────────────────────────┤
│ ┌─────────────┐  ┌─────────────┐  ┌─────────────┐           │
│ │ Anthropic ● │  │ OpenAI  ●   │  │ Ollama  ◌   │  ← status │
│ │ api.anth…   │  │ api.openai… │  │ localhost…  │           │
│ │ 5 models    │  │ 12 models   │  │ Local       │           │
│ │ [Test]      │  │ [Test]      │  │ [Test]      │           │
│ └─────────────┘  └─────────────┘  └─────────────┘           │
└──────────────────────────────────────────────────────────────┘
```

**Component:** `components/admin/orchestration/providers-list.tsx` (client island, takes `initialProviders: ProviderRow[]` from the server shell).

### Status dot rules

| Colour | Meaning                                                                                 |
| ------ | --------------------------------------------------------------------------------------- |
| Green  | `apiKeyPresent === true` AND a test-connection click in the current session returned OK |
| Red    | Test failed this session OR `apiKeyPresent === false` on a non-local provider           |
| Grey   | Not tested yet this session (default on first paint)                                    |

Test-connection results live in component state only — we never persist them. On the next page refresh every dot resets to grey (unless the env var is missing, in which case it stays red).

The dot is `aria-hidden` with an adjacent visible text label describing the state ("Connected", "Key missing", "Test failed", "Not tested").

### Lazy model count (cached)

Each card fires `GET /providers/:id/models` after first paint and shows the model count inline. Failures render `—`. Local providers additionally show a small `<Badge>Local</Badge>` because their model list is "what's pulled" rather than "what's priced".

Model counts are cached client-side with a 60-second TTL in a module-level `Map`. This prevents redundant N+1 fetches when navigating back to the list page within the same session. The cache is invalidated by the "Refresh models" action in the models dialog.

### Circuit breaker badge

When the provider's circuit breaker is **open** or **half-open** (included in the list response), a small warning badge renders below the status dot:

- **Open** — orange badge "Circuit open" with a "Reset" button that POSTs to `/providers/:id/health`.
- **Half-open** — yellow badge "Circuit half-open".
- **Closed** — nothing shown (healthy default).

The badge disappears immediately on successful reset (re-fetches provider health inline).

### Card actions

- **Edit** — links to `/admin/orchestration/providers/:id`.
- **Reactivate** — shown only when `isActive === false`. PATCHes `{ isActive: true }` and updates local state. Provides a quick path back without navigating to the edit form.
- **View models** — opens an inline `<Dialog>` rendering `<ProviderModelsPanel>` (see below). A dialog is lighter than a sub-route and keeps the admin in context.
- **Delete** — inline `<DeleteProviderDialog>` → `DELETE /providers/:id` (soft delete via `isActive = false`). The dialog warns that agents referencing this slug will error on their next chat turn until reactivated. The card remains visible with an Inactive badge; the admin can reactivate from the dropdown menu.

### Test connection

Per-card `<ProviderTestButton providerId={p.id}>` — see the extract below. The button's `onResult` callback feeds back into the card's `testedOk` state to update the status dot.

## `<ProviderModelsPanel>` — model catalogue dialog

**File:** `components/admin/orchestration/provider-models-panel.tsx`

Table columns (sortable headers carry hover tooltips that name the upstream data source):

| Column        | Source                                 | Notes                                                                                                                |
| ------------- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Model         | `model.name` / `model.id`              | Two-line cell, id in monospace below name                                                                            |
| In matrix     | `model.inMatrix`                       | Green badge when the model has a matching `AiProviderModel` row; em-dash otherwise                                   |
| In use        | `model.agents`                         | Count badge linking to the agents bound to `(providerSlug, modelId)`; em-dash when empty                             |
| Capabilities  | `model.capabilities`                   | One badge per capability (chat / embedding / reasoning / image / audio / moderation / unknown)                       |
| Context       | `model.maxContext`                     | `N tok` with thousands separator. Renders `—` with a hover tooltip when the value is 0 (see "Unknown values" below). |
| Tier          | `model.tier`                           | Capitalized                                                                                                          |
| Input $/1M    | `model.inputCostPerMillion`            | Right-aligned tabular. Renders `—` with tooltip when 0. **Hidden when `isLocal === true`**                           |
| Output $/1M   | `model.outputCostPerMillion`           | Right-aligned tabular. Renders `—` with tooltip when 0. **Hidden when `isLocal === true`**                           |
| Available     | `model.available`                      | Green ✓ / `—`                                                                                                        |
| Test          | per-row Test button (capability-aware) | See "Per-model test button" below                                                                                    |
| Add to matrix | "Add" button when `inMatrix === false` | Opens the discovery dialog with this row pre-selected                                                                |

The panel fetches `GET /providers/:id/models` on mount. **Refresh models** re-fetches. Loading renders a spinner; failures render a friendly red banner ("Couldn't load models. Check the server logs for details.") — the server route has already sanitized the upstream error.

### Unknown / free values (Context / Input $/1M / Output $/1M)

Context length and pricing come from OpenRouter's public catalogue, refreshed every 24h (`lib/orchestration/llm/model-registry.ts:refreshFromOpenRouter`). Each cost cell distinguishes three states:

- **Known non-zero** — renders `$X.XX` with no tooltip; the column header tooltip names the source.
- **Free (zero pricing in OpenRouter)** — renders **Free** in green with a `cursor-help` span. Hover: "Listed in OpenRouter with zero per-token pricing — typically promotional or community access (e.g. :free model variants)." Detected via `tier === 'local'` on a non-local provider's row, since the OpenRouter parser's `classifyTier(0)` returns `'local'` and the openai-compatible fallback for unknown models forces `'mid'`.
- **Unknown (not in OpenRouter)** — renders `—` with `cursor-help`. Hover wording differs by provider type:
  - **Remote** — "Not listed in OpenRouter's catalogue — common for niche fine-tunes and embedding-only models."
  - **Local** — "Local providers don't expose context length via the /v1/models endpoint — the value isn't reported by the host." (Cost columns are hidden for local providers, so this only applies to Context.)

### Per-model test button

Each model row includes a small Test button. The button is **capability-aware**:

- **`chat`** rows — enabled. Hover tooltip: "Sends a small 'Say hello.' prompt (max 10 tokens) and reports round-trip latency. Verifies the API key, base URL, and model are reachable."
- **`embedding`** rows — enabled. Hover tooltip: "Embeds the string 'hello' and reports round-trip latency. Verifies the API key, base URL, and model are reachable."
- **`audio`** rows — enabled. Hover tooltip: "Posts a tiny silent WAV (1 second of 16 kHz mono PCM, ~32 kB) to the provider's transcription endpoint and reports round-trip latency. Verifies the API key, base URL, and model are reachable. The transcript will usually be empty — that's expected." The clip is generated in-process via `lib/audio/silent-wav.ts`; the test only cares about a successful round-trip (auth, base URL and model id all valid), not the transcript content. Providers whose backing class does not implement the optional `transcribe()` method (currently anything other than `OpenAiCompatibleProvider` — e.g. Anthropic, Voyage) return a structured `error: 'provider_no_audio_support'` response with a friendly message naming the supported families (OpenAI, Groq, Together, Fireworks). The route never throws a TypeError.
- **`reasoning` / `image` / `moderation` / `unknown`** — disabled (50% opacity). Hover tooltip explains the specific reason (e.g. "Reasoning models use the /v1/responses API — testing through this panel is not supported yet").

Click → POSTs `/providers/:id/test-model` with `{ model: modelId, capability }`. On success, displays latency in ms (e.g. "320 ms") in green. On failure, shows a friendly message in red — the API returns a generic `error: 'model_test_failed'` code, never the raw SDK error, consistent with the SSRF defense pattern used by `/test` and `/models`. The `provider_no_audio_support` branch is the one exception — its message is safe to surface because it describes the provider class, not the upstream HTTP error.

## `<ProviderTestButton>` — shared extract

**File:** `components/admin/orchestration/provider-test-button.tsx`

Extracted in this session from the `AgentForm` Model tab so both forms share one code path. Props:

```ts
interface ProviderTestButtonProps {
  providerId: string | null; // null = "no saved config yet"
  onResult?: (ok: boolean) => void; // feeds status dots in providers-list
  disabledMessage?: string; // copy shown when providerId is null
}
```

Behaviour:

- POSTs `/providers/:id/test` on click.
- **Success** → green "N models available" (reads `modelCount` from the response).
- **Failure** → red "Couldn't reach this provider. Check the server logs for details." The raw SDK error is never forwarded to the DOM — the server route sanitizes first, and the client layers on this fallback regardless.
- `providerId === null` → renders the `disabledMessage` on click. Used by `AgentForm` before the user has saved the selected provider slug as a real row.

The AgentForm Model tab test still pins this behaviour — see `tests/unit/components/admin/orchestration/agent-form-model.test.tsx`.

## API-key-env-var-only security model

**The UI never accepts, stores, transmits, or displays a raw API key value.**

The provider row stores `apiKeyEnvVar: 'ANTHROPIC_API_KEY'` — just the **name** of an environment variable. The backend reads `process.env[…]` at request time, and the list route hydrates every row with `apiKeyPresent: boolean` (via `isApiKeyEnvVarSet()` in `lib/orchestration/llm/provider-manager.ts`). The value itself is never rendered.

Consequences:

- Rotating a key means changing the env var on the server and restarting — no database migration, no UI interaction.
- An admin exporting a provider bundle can safely share it; no secrets leak.
- The provider card can show a red "missing" indicator without ever needing to know the value.
- Static code search for API-key-shaped literals is effective: the repo should never contain one.

## Default providers seeded by `prisma/seed.ts`

Running `npm run db:seed` upserts three rows keyed by slug. The `create` branch writes sensible defaults, the `update` branch is **intentionally empty** so re-running the seeder against admin-edited rows is a no-op.

| Slug           | providerType        | baseUrl                     | apiKeyEnvVar        | isLocal | isActive at seed time             |
| -------------- | ------------------- | --------------------------- | ------------------- | ------- | --------------------------------- |
| `anthropic`    | `anthropic`         | `null`                      | `ANTHROPIC_API_KEY` | false   | `!!process.env.ANTHROPIC_API_KEY` |
| `openai`       | `openai-compatible` | `https://api.openai.com/v1` | `OPENAI_API_KEY`    | false   | `!!process.env.OPENAI_API_KEY`    |
| `ollama-local` | `openai-compatible` | `http://localhost:11434/v1` | `null`              | true    | `false`                           |

A fresh install with `ANTHROPIC_API_KEY` exported lights up Anthropic immediately. Admins can edit any of these rows in the UI without fear of losing their changes on the next seed.

In development, the clear block deletes `AiProviderConfig` rows before deleting users to avoid a `createdBy` foreign-key violation.

## Provider Models (Selection Matrix)

`AiProviderConfig` tracks **operational config** (API keys, base URLs, timeouts). For **per-model intelligence** — tier classification, reasoning depth, latency characteristics, cost efficiency, embedding capabilities, and recommended agent roles — see the separate **Provider Models** system.

Provider models are stored in the `AiProviderModel` table and managed at `/admin/orchestration/provider-models`. They are linked to configs via a soft match on `providerSlug` → `AiProviderConfig.slug` — a model entry can exist without a config (landscape entry) and vice versa.

The flat table view shows all models with filters for provider, tier, and capability (Chat / Embedding / All). Each row shows capability badges and a configured-status dot (green = matching `AiProviderConfig` exists and is active). A built-in decision heuristic recommends models for a given task intent (`thinking`, `doing`, `fast_looping`, `high_reliability`, `private`, `embedding`).

The embedding models in this table also power the "Compare Embedding Providers" modal on the Knowledge Base page, providing a single source of truth for embedding model data.

See [Provider Selection Matrix](../orchestration/provider-selection-matrix.md) for full details.

## Related

- [Provider form](./provider-form.md) — 16-flavor selector, reverse-mapping, field help
- [Provider Selection Matrix](../orchestration/provider-selection-matrix.md) — tier classification, decision heuristic, model CRUD
- [LLM providers (runtime)](../orchestration/llm-providers.md) — provider abstraction, model registry, cost tracking
- [Admin API reference](../orchestration/admin-api.md)
- [Agent form](./agent-form.md) — the Model tab consumes the same `<ProviderTestButton>`
