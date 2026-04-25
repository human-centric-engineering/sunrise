# Costs & Budget dashboard

Admin page at `/admin/orchestration/costs`. Surfaces every spend / budget signal the orchestration layer emits and hosts the editable defaults that influence routing and budget enforcement.

**Page shell:** `app/admin/orchestration/costs/page.tsx` — async server component.
**Client island:** `components/admin/orchestration/costs/costs-view.tsx`.
**Landed:** Phase 4 Session 4.4.

## Layout

```
┌─────────────────────────────────────────────────────────────────┐
│ Summary cards  ·  Today │ Week │ Month │ Projected              │
├─────────────────────────────────────────────────────────────────┤
│ Budget alerts list  (global cap banner + agents ≥ 80%)           │
├─────────────────────────────────────────────────────────────────┤
│ 30-day trend chart  (stacked Area by tier)                      │
├──────────────────────────────┬──────────────────────────────────┤
│ Per-agent spend table        │ Per-model breakdown table        │
├──────────────────────────────┴──────────────────────────────────┤
│ Local vs cloud panel  (pie + savings callout)                   │
├─────────────────────────────────────────────────────────────────┤
│ Pricing reference  (collapsible — model rates, source, synced)  │
├─────────────────────────────────────────────────────────────────┤
│ How costs are calculated  (measured vs est, tokenomics, guides) │
├─────────────────────────────────────────────────────────────────┤
│ Configuration form  (task defaults + global monthly cap)        │
└─────────────────────────────────────────────────────────────────┘
```

## Data sources

The server shell fires six parallel null-safe fetches via `serverFetch()`. Any upstream failure renders an empty state in its section — the page never throws.

| Section                | Endpoint                                                    | Notes                                                  |
| ---------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| Summary cards          | `GET /costs/summary`                                        | `totals.today` / `week` / `month`                      |
| Trend chart (totals)   | `GET /costs/summary` (`trend[]`)                            | Daily total only — tier split synthesised client-side  |
| Trend chart (per-tier) | `GET /costs?groupBy=model&dateFrom=<30d>&dateTo=<today>`    | Rows bucketed to tiers via `/models` on the client     |
| Per-agent table        | `GET /costs/summary` (`byAgent[]`)                          | Joined with `monthlyBudgetUsd` server-side             |
| Per-model table        | `GET /costs/summary` (`byModel[]`) + `GET /models`          | Joined to annotate provider / tier / local badge       |
| Local vs cloud panel   | `GET /costs/summary.localSavings` + `byModel[]` + `/models` | `localSavings: null` → muted placeholder, never throws |
| Budget alerts list     | `GET /costs/alerts`                                         | Returns `{ alerts, globalCap }` — sorted by severity   |
| Configuration form     | `GET /settings` + `GET /models`                             | Singleton upsert-on-read                               |

## Trend chart — tier synthesis

`/costs/summary.trend` only returns `{ date, totalCostUsd }` — no tier split. To render the stacked area by tier the page fetches `/costs?groupBy=model&dateFrom=…&dateTo=…` in parallel, buckets each model id to its tier against `/models`, and then distributes each day's total proportionally to the 30-day tier mix.

This is an approximation (a day with a spike in frontier usage still shows the 30-day-average tier split), but it requires no backend changes and degrades gracefully: if the per-model fetch fails, the chart falls back to a single area built from the raw `trend[]` totals.

### Zero-fill for missing days

The API omits days with no spend from the trend response. The `fillZeroDays()` helper in the chart component generates the full 30-day date range and fills gaps with `totalCostUsd: 0`. This prevents the chart from drawing misleading connecting lines across multi-day gaps. If every day has zero spend, the chart shows the "No spend recorded" empty state.

## Local savings methodology

`calculateLocalSavings()` in `lib/orchestration/llm/cost-tracker.ts` reads every `isLocal: true` row from the rolling month window and, per row, prices the same token counts against the cheapest non-local model in the same tier — the savings are (what-you-would-have-paid − 0).

| Value           | Meaning                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tier_fallback` | Substituted with the cheapest non-local model in the reported tier. This is the only reachable mode today — local rows always carry local model ids, so there is never a direct hosted equivalent to match against. |

The `methodology` field is retained as a single-value union on `LocalSavingsResult` so future modes (e.g. `equivalent_hosted` when local models gain a hosted-alias mapping) can be added without a response-shape break.

On any error — registry lookup blew up, Prisma threw, anything — the helper returns `null` and the rest of `getCostSummary()` still renders. The UI shows "—" in the savings callout in that case.

## Settings form semantics

The form edits a single `AiOrchestrationSettings` row (`slug: 'global'`, lazily upserted by `GET /settings`). Two sections:

### Default model assignments

A select for each `TaskType`: `routing` / `chat` / `reasoning` / `embeddings`. Saved via `PATCH /settings { defaultModels }`. The route validates every id against the in-memory model registry (via `validateTaskDefaults()` in `model-registry.ts`) and returns a 400 if any id is unknown — admins can't smuggle a typo through.

The values resolve at runtime via `getDefaultModelForTask(task)` in `lib/orchestration/llm/settings-resolver.ts`, which is called whenever the chat handler needs a model for a task that the agent has not explicitly overridden. A 30-second in-memory TTL cache sits in front of the Prisma read; PATCH calls `invalidateSettingsCache()` so the next chat turn picks up the change immediately.

### Global monthly budget cap (read-only reference)

This section displays the current global cap value (or "No global cap set") as read-only text with a link to `/admin/orchestration/settings` where the cap is managed. The cap is NOT editable on the costs page — it lives on the dedicated Settings page to keep the costs page focused on reporting and the settings page focused on configuration.

**Enforcement:** When set, `cost-tracker.ts#checkBudget()` additionally computes the month-to-date spend _across all agents_ (`getMonthToDateGlobalSpend()`) and flips `globalCapExceeded: true` when the cumulative total is at or above the cap. The streaming chat handler short-circuits on that flag with the `BUDGET_EXCEEDED_GLOBAL` error code so the SSE `error` frame sanitises distinctly from per-agent overruns.

The global cap enforcement is wrapped in try/catch so a transient settings fetch failure degrades gracefully to the per-agent path — it never blocks chat globally because Prisma hiccuped.

## Field help voice

Every non-trivial field is wrapped in `<FieldHelp>`. Reference copy (mirror the voice in later sessions):

- **Routing model** — "Used for fast classification decisions (e.g. 'which specialist agent should handle this question?'). A cheap, fast model is usually the right choice."
- **Default chat model** — "Fallback model for agents that have not explicitly set their own model. Changing this immediately affects every agent using the 'use default' option."
- **Reasoning model** — "Used for multi-step reasoning tasks (tool loops, complex planning, capability orchestration). Favour a frontier model for reliability."
- **Embeddings model** — "Used by the knowledge-base retrieval pipeline to embed both documents at ingest time and queries at search time. Changing this invalidates existing embeddings — re-index before you expect retrieval to work correctly."
- **Global cap** — "When set, the streaming chat handler refuses any new turn whose cumulative month-to-date spend across all agents would meet or exceed this value."
- **Projected month card** — "Extrapolates the current month-to-date spend to the end of the month using a simple per-day run rate."

## Global cap exceeded banner

When the platform-wide monthly budget cap is exceeded, `BudgetAlertsList` renders a prominent red banner at the top of the alerts section showing the current spend vs cap (e.g. "$542.00 of $500.00") with a link to `/admin/orchestration/settings`. This is driven by `globalCap: GlobalCapStatus` returned alongside per-agent alerts from `GET /costs/alerts`. The `GlobalCapStatus` shape is `{ cap: number | null, spent: number, exceeded: boolean }`, produced by `getGlobalCapStatus()` in `cost-reports.ts`.

## Pause-agent flow

`BudgetAlertsList` (client island, distinct from the dashboard's `BudgetAlertsBanner`) renders two actions per alert row:

1. **Adjust budget** — `<Link>` to `/admin/orchestration/agents/:id`.
2. **Pause agent** — `apiClient.patch('/agents/:id', { isActive: false })` with optimistic update. The row is marked paused immediately; on failure the state reverts and an inline error banner surfaces the reason. No new endpoint is introduced — the existing admin `PATCH /agents/:id` handles this and is already admin-guarded and rate-limited.

## Type naming

Two `CostSummary`-like types exist, deliberately named differently:

| Type               | Module                                  | Usage                                                                  |
| ------------------ | --------------------------------------- | ---------------------------------------------------------------------- |
| `CostSummary`      | `lib/orchestration/llm/cost-reports.ts` | Dashboard-level totals/byAgent/byModel/trend/localSavings              |
| `AgentCostSummary` | `types/orchestration.ts`                | Per-agent breakdown with raw entries array (used by `getAgentCosts()`) |

## Pricing reference panel

`PricingReference` — collapsible card (starts collapsed) showing the per-model token rates used to calculate spend figures.

**Data source:** `/models` endpoint now returns `fetchedAt` (epoch ms) alongside the model list. The server shell passes both `models` and `registryFetchedAt` to the client island.

**Content when expanded:**

- Per-model table: name, provider, tier, input rate, output rate, source badge
- Source badge: "Live" (OpenRouter feed active, refreshed every 24h) or "Fallback" (static hardcoded rates, used when OpenRouter is unreachable)
- "Last synced" relative timestamp in the header (e.g. "2h ago", "Never (using static fallback)")
- Explainer text on rate meaning and typical token consumption

**Pricing source pipeline:** Static fallback map (compiled in) → OpenRouter `/api/v1/models` (24h cache, Zod-validated) → per-provider discovery (marks `available: true`). The cost tracker multiplies actual token counts by these rates.

**OpenRouter refresh on page load:** The costs page calls `refreshFromOpenRouter()` before rendering, ensuring current-rate data is never more than 24h stale (no-op when cache is warm).

## Cost methodology panel

`CostMethodology` — always-visible educational section explaining how costs are calculated and what the numbers mean.

**Sections:**

1. **Measured vs Estimated** — two-column card distinguishing exact data (token counts, model attribution, timestamps) from approximations (per-token rates, tier breakdown, projections).
2. **Tokenomics education** — explains tokens, input vs output pricing asymmetry, industry trends (falling prices, output-heavy costs, context length impact, local models).
3. **Quick cost guide** — table of common use cases (classification, chat, RAG, reasoning, summarization) with recommended tier and typical cost-per-request range.
4. **Workflow cost estimation** — simple/complex workflow cost ranges with the tip to use budget-tier for structured tasks.

## Workflow template cost indicator

The `TemplateBanner` in the workflow builder now shows an estimated cost-per-run badge when `workflowDefinition` is provided. The estimate counts LLM-consuming step types (`llm_call`, `chain`, `reflect`, `evaluate`, `plan`, `route`, `agent_call`) and multiplies by a per-step cost range from budget-tier ($0.002/step) to frontier-tier ($0.05/step).

The badge format is `$low–$high/run` and includes a tooltip explaining the methodology. Workflows with no LLM steps show no badge.

## Cross-references

- [`.context/admin/agent-form.md`](./agent-form.md) — per-agent budget field
- [`.context/admin/provider-form.md`](./provider-form.md) — where API keys live
- [`.context/admin/workflow-builder.md`](./workflow-builder.md) — template banner, cost indicator
- [`.context/orchestration/admin-api.md`](../orchestration/admin-api.md) — `/settings`, `/costs`, `/costs/summary`, `/costs/alerts`
- [`.context/orchestration/llm-providers.md`](../orchestration/llm-providers.md) — `getDefaultModelForTask` in `settings-resolver.ts`
- [`.context/api/orchestration-endpoints.md`](../api/orchestration-endpoints.md) — consumer HTTP reference
