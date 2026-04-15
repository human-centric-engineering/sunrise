# Provider management pages

Admin list/create/edit flows for `AiProviderConfig`. Landed in Phase 4 Session 4.3. Providers are the **LLM backends** your agents can call — Anthropic, OpenAI, Ollama, or any OpenAI-compatible service.

**Pages**

| Route                                 | File                                              | Role                                 |
| ------------------------------------- | ------------------------------------------------- | ------------------------------------ |
| `/admin/orchestration/providers`      | `app/admin/orchestration/providers/page.tsx`      | Card grid, status dots, model dialog |
| `/admin/orchestration/providers/new`  | `app/admin/orchestration/providers/new/page.tsx`  | Create shell                         |
| `/admin/orchestration/providers/[id]` | `app/admin/orchestration/providers/[id]/page.tsx` | Edit shell, `notFound()` on missing  |

All three are async server components that query Prisma directly (see `.context/architecture/data-fetching.md`). Fetch failures fall back to an empty grid and are logged with `logger.error`.

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

The dot is decorative but has an accessible `title`/`aria-label` describing the state ("Tested OK this session", "Missing API key env var", etc.).

### Lazy model count

Each card fires `GET /providers/:id/models` after first paint and shows the model count inline. Failures render `—`. Local providers additionally show a small `<Badge>Local</Badge>` because their model list is "what's pulled" rather than "what's priced".

### Card actions

- **Edit** — links to `/admin/orchestration/providers/:id`.
- **View models** — opens an inline `<Dialog>` rendering `<ProviderModelsPanel>` (see below). A dialog is lighter than a sub-route and keeps the admin in context.
- **Delete** — inline `<DeleteProviderDialog>` → `DELETE /providers/:id` (soft delete via `isActive = false`). The dialog warns that agents referencing this slug will error on their next chat turn until reactivated.

### Test connection

Per-card `<ProviderTestButton providerId={p.id}>` — see the extract below. The button's `onResult` callback feeds back into the card's `testedOk` state to update the status dot.

## `<ProviderModelsPanel>` — model catalogue dialog

**File:** `components/admin/orchestration/provider-models-panel.tsx`

Table columns:

| Column      | Source                       | Notes                                                     |
| ----------- | ---------------------------- | --------------------------------------------------------- |
| Model       | `model.name` / `model.id`    | Two-line cell, id in monospace below name                 |
| Context     | `model.maxContext`           | `N tok` with thousands separator                          |
| Tier        | `model.tier`                 | Capitalized                                               |
| Input $/1M  | `model.inputCostPerMillion`  | Right-aligned tabular. **Hidden when `isLocal === true`** |
| Output $/1M | `model.outputCostPerMillion` | Right-aligned tabular. **Hidden when `isLocal === true`** |
| Available   | `model.available`            | Green ✓ / `—`                                             |

The panel fetches `GET /providers/:id/models` on mount. **Refresh models** re-fetches. Loading renders a spinner; failures render a friendly red banner ("Couldn't load models. Check the server logs for details.") — the server route has already sanitized the upstream error.

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

## Related

- [Provider form](./provider-form.md) — 4-flavor selector, reverse-mapping, field help
- [LLM providers (runtime)](../orchestration/llm-providers.md) — provider abstraction, model registry, cost tracking
- [Admin API reference](../orchestration/admin-api.md)
- [Agent form](./agent-form.md) — the Model tab consumes the same `<ProviderTestButton>`
