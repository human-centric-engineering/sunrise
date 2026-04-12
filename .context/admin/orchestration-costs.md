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
│ Budget alerts list  (agents ≥ 80% — Adjust / Pause)             │
├─────────────────────────────────────────────────────────────────┤
│ 30-day trend chart  (stacked Area by tier)                      │
├──────────────────────────────┬──────────────────────────────────┤
│ Per-agent spend table        │ Per-model breakdown table        │
├──────────────────────────────┴──────────────────────────────────┤
│ Local vs cloud panel  (pie + savings callout)                   │
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
| Budget alerts list     | `GET /costs/alerts`                                         | Already sorted by severity + utilisation               |
| Configuration form     | `GET /settings` + `GET /models`                             | Singleton upsert-on-read                               |

## Trend chart — tier synthesis

`/costs/summary.trend` only returns `{ date, totalCostUsd }` — no tier split. To render the stacked area by tier the page fetches `/costs?groupBy=model&dateFrom=…&dateTo=…` in parallel, buckets each model id to its tier against `/models`, and then distributes each day's total proportionally to the 30-day tier mix.

This is an approximation (a day with a spike in frontier usage still shows the 30-day-average tier split), but it requires no backend changes and degrades gracefully: if the per-model fetch fails, the chart falls back to a single area built from the raw `trend[]` totals.

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

The values resolve at runtime via `getDefaultModelForTask(task)` in `lib/orchestration/llm/model-registry.ts`, which is called whenever the chat handler needs a model for a task that the agent has not explicitly overridden. A 30-second in-memory TTL cache sits in front of the Prisma read; PATCH calls `invalidateSettingsCache()` so the next chat turn picks up the change immediately.

### Global monthly budget cap

A single numeric input. Empty = "no cap". Saved via `PATCH /settings { globalMonthlyBudgetUsd }`.

When set, `cost-tracker.ts#checkBudget()` additionally computes the month-to-date spend _across all agents_ (`getMonthToDateGlobalSpend()`) and flips `globalCapExceeded: true` when the cumulative total is at or above the cap. The streaming chat handler short-circuits on that flag with the `BUDGET_EXCEEDED_GLOBAL` error code so the SSE `error` frame sanitises distinctly from per-agent overruns.

The global cap enforcement is wrapped in try/catch so a transient settings fetch failure degrades gracefully to the per-agent path — it never blocks chat globally because Prisma hiccuped.

## Field help voice

Every non-trivial field is wrapped in `<FieldHelp>`. Reference copy (mirror the voice in later sessions):

- **Routing model** — "Used for fast classification decisions (e.g. 'which specialist agent should handle this question?'). A cheap, fast model is usually the right choice."
- **Default chat model** — "Fallback model for agents that have not explicitly set their own model. Changing this immediately affects every agent using the 'use default' option."
- **Reasoning model** — "Used for multi-step reasoning tasks (tool loops, complex planning, capability orchestration). Favour a frontier model for reliability."
- **Embeddings model** — "Used by the knowledge-base retrieval pipeline to embed both documents at ingest time and queries at search time. Changing this invalidates existing embeddings — re-index before you expect retrieval to work correctly."
- **Global cap** — "When set, the streaming chat handler refuses any new turn whose cumulative month-to-date spend across all agents would meet or exceed this value."
- **Projected month card** — "Extrapolates the current month-to-date spend to the end of the month using a simple per-day run rate."

## Pause-agent flow

`BudgetAlertsList` (client island, distinct from the dashboard's `BudgetAlertsBanner`) renders two actions per alert row:

1. **Adjust budget** — `<Link>` to `/admin/orchestration/agents/:id`.
2. **Pause agent** — `apiClient.patch('/agents/:id', { isActive: false })` with optimistic update. The row is marked paused immediately; on failure the state reverts and an inline error banner surfaces the reason. No new endpoint is introduced — the existing admin `PATCH /agents/:id` handles this and is already admin-guarded and rate-limited.

## Cross-references

- [`.context/admin/agent-form.md`](./agent-form.md) — per-agent budget field
- [`.context/admin/provider-form.md`](./provider-form.md) — where API keys live
- [`.context/orchestration/admin-api.md`](../orchestration/admin-api.md) — `/settings`, `/costs`, `/costs/summary`, `/costs/alerts`
- [`.context/orchestration/llm-providers.md`](../orchestration/llm-providers.md) — `getDefaultModelForTask` resolver
- [`.context/api/orchestration-endpoints.md`](../api/orchestration-endpoints.md) — consumer HTTP reference
