# Costs & Budget dashboard

Admin page at `/admin/orchestration/costs`. Surfaces every spend / budget signal the orchestration layer emits and hosts the editable defaults that influence routing and budget enforcement.

**Page shell:** `app/admin/orchestration/costs/page.tsx` — async server component.
**Client island:** `components/admin/orchestration/costs/costs-view.tsx`.

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
│ Per-org usage table  (more than one org, or detached spend)     │
├─────────────────────────────────────────────────────────────────┤
│ Local vs cloud panel  (pie + savings callout)                   │
├─────────────────────────────────────────────────────────────────┤
│ Pricing reference  (collapsible — model rates, source, synced)  │
├─────────────────────────────────────────────────────────────────┤
│ How costs are calculated  (measured vs est, tokenomics, guides) │
├─────────────────────────────────────────────────────────────────┤
│ Footer link → Settings  (default models + global monthly cap)   │
└─────────────────────────────────────────────────────────────────┘
```

The default-models form and global monthly cap used to live on this page; they were moved to the dedicated Settings page (`/admin/orchestration/settings`) so the Costs page stays focused on reporting. The footer card on this page is a small pointer with a button-link to Settings — it does not fetch or edit configuration.

## Data sources

The server shell fires five parallel fetches through `lib/api/server-load.ts`, and a failed load never renders as an empty state (#518). `/costs/summary` is required: it feeds the summary cards, the trend, both breakdown tables and the local-vs-cloud panel, and `<CostsView>` would render it missing as "no spend", so its failure throws to the admin error boundary, whose **Try again** re-fetches. A failed `/costs/alerts` shows a "Couldn't load budget alerts" notice in the alerts panel's place — never "No agents are currently over 80% of their monthly budget" — and the rest of the page renders. The per-model breakdown, `/models` and `/costs/orgs` are optional: a failure shows a "Couldn't load …" notice above the view and the rest of the page renders. A 403 from `/costs/orgs` is the expected refusal outside the install org and hides that table without a notice.

| Section                | Endpoint                                                    | Notes                                                  |
| ---------------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| Summary cards          | `GET /costs/summary`                                        | `totals.today` / `week` / `month`                      |
| Trend chart (totals)   | `GET /costs/summary` (`trend[]`)                            | Daily total only — tier split synthesised client-side  |
| Trend chart (per-tier) | `GET /costs?groupBy=model&dateFrom=<30d>&dateTo=<today>`    | Rows bucketed to tiers via `/models` on the client     |
| Per-agent table        | `GET /costs/summary` (`byAgent[]`)                          | Joined with `monthlyBudgetUsd` server-side             |
| Per-model table        | `GET /costs/summary` (`byModel[]`) + `GET /models`          | Keyed `provider::modelId` — see below                  |
| Local vs cloud panel   | `GET /costs/summary.localSavings` + `byModel[]` + `/models` | `localSavings: null` → muted placeholder, never throws |
| Budget alerts list     | `GET /costs/alerts`                                         | Returns `{ alerts, globalCap }` — sorted by severity   |
| Per-org usage table    | `GET /costs/orgs`                                           | Install org only at `multi`; see Per-org usage         |

### Per-model rows carry their provider

`byModel[]` rows are `{ model, provider, monthSpend }`, grouped by both columns of
`AiCostLog`. The provider is load-bearing, not decoration: the same bare `modelId`
can exist under several providers in the matrix — `gpt-4o` ships under `openai`
and (inactive) under `microsoft` — so a catalogue lookup keyed on the id alone
resolves to whichever entry was merged last, and `mergeDbModelsWithRegistry`
appends DB-only rows at the end. That is how genuine OpenAI spend came to render
as `microsoft / "GPT-4o (Azure)"`.

Consumers use `buildModelIndex` / `lookupModel`
(`components/admin/orchestration/costs/model-index.ts`), which matches
`provider::modelId` first and falls back to the bare id only for providers absent
from the catalogue. The Provider column shows `row.provider` from the cost log —
the provider that actually billed — not the catalogue entry's own provider field.

The trend chart is the exception: its rows come from `GET /costs?groupBy=model`,
which groups by model alone, so its tier lookup stays bare-id and first-write-wins.
A shared id whose two entries sit in different tiers can still be bucketed to the
wrong wedge there.

Before fetching, the page also calls `refreshFromOpenRouter()` once so the model registry's per-token rates are at most 24 h stale. The call is heavily cached and a no-op on warm pages.

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

## Defaults & global cap (managed on the Settings page)

The default-model assignments and the global monthly budget cap are edited on `/admin/orchestration/settings` — see [`orchestration-settings.md`](./orchestration-settings.md) for the form itself. This section documents how those values are consumed by the cost/budget runtime, which is the part a Costs reader usually cares about.

### Default model assignments

The Settings form writes per-task defaults to the single `AiOrchestrationSettings` row (`slug: 'global'`, lazily upserted by `GET /settings`). Task slots: `routing` / `chat` / `reasoning` / `embeddings` / `audio`. Saved via `PATCH /settings { defaultModels }`.

Validation lives in `app/api/v1/admin/orchestration/settings/route.ts`:

- chat/routing/reasoning ids are checked via `validateTaskDefaults()` in `model-registry.ts` — each id must resolve through `getModel()` in the chat-model registry.
- the `embeddings` slot is validated separately against the DB-backed embedding-model registry (`getEmbeddingModels()`) because those ids aren't in the synchronous chat registry.
- the `audio` slot is parsed by `parseAudioDefault()` and matched against the available audio models.

Defence-in-depth: bogus ids never reach the DB, even if a non-form caller PATCHes the endpoint directly.

At runtime, values resolve via `getDefaultModelForTask(task)` in `lib/orchestration/llm/settings-resolver.ts`, called whenever the chat handler needs a model for a task the agent has not explicitly overridden. A 30-second in-memory TTL cache sits in front of the Prisma read; PATCH calls `invalidateSettingsCache()` so the next chat turn picks up the change immediately.

### Global monthly budget cap — enforcement

When the cap is set on the Settings page, the month-to-date spend _across every org_ (`getMonthToDateGlobalSpend()`) is checked against it, and `globalCapExceeded: true` is reported when the cumulative total is at or above the cap. The cap is the operator's ceiling on the shared provider keys, so at `TENANCY_MODE=multi` the total is summed in the system scope (`globalSpendSince()` in `lib/orchestration/admin/global-config-usage.ts`). Otherwise the `org_isolation` policy would show it only the acting org's rows, and the cap would act as a per-org cap. Detached `NULL`-org rows count too. `getGlobalCapState()` in `lib/orchestration/llm/spend-caps.ts` is the one place that reads the cap and the total. `checkBudget()`, the provider manager's spend gate, the agents list's budget column and `getGlobalCapStatus()` (behind `GET /costs/alerts`) all call it. Because the total includes every org's spend, `GET /costs/alerts` returns it only to a caller in the install org; in a customer org at `multi` `globalCap.spent` is `null`, and the caller is told only whether the cap is reached.

**It holds every paid AI call, not only chat.** The provider manager runs the spend gate (`assertWithinSpendCaps`) before every vendor call, so a workflow step, the orchestrator, an evaluation, a judge, knowledge ingestion and a scheduled or webhook run are refused with `global_budget_exceeded` once the cap is reached. A local provider is never refused, because it costs nothing. See [LLM providers → The spend gate](../orchestration/llm-providers.md#the-spend-gate).

**The total is cached for 10 seconds per process.** Summing a month of every org's cost rows on every call would make the check cost more as tenants are added. `logCost` adds each row it writes to the cached total at once, so a process sees its own spend immediately and another process's within 10 seconds. That window, plus one turn per agent under the per-agent lock, is how far the cap can be overrun. The cap's value is read from the settings singleton, which is cached for 30 seconds. Saving it on the Settings page, or restoring a backup that includes settings, clears that cache in the process that did it; other processes pick it up within 30 seconds.

A cap that cannot be read is logged and skipped (`globalCapStateOrSkip()`), so a transient settings fetch failure degrades to the other caps. It never blocks AI calls globally because Prisma hiccuped, and in the agents list it never drops the other budget figures.

### Per-org monthly budget cap

An org can have a cap of its own: `monthlyBudgetUsd` under the `quotas` key of `Org.settings` (§110 t-788). `checkBudget()` reads it for the agent's org and sums the org's month-to-date spend with an explicit `orgId` filter, over the same UTC calendar month as the agent and global checks. When that spend is at or above the cap it sets `orgCapExceeded: true` and reports `org: { limit, spent }`. The global cap still sits above every org's cap.

- **Unset means no org cap.** With no `quotas` slice, `checkBudget()` returns exactly what it did before org caps existed, and the org's spend is never summed.
- **It holds every paid AI call in the org, not only chat.** The provider manager's spend gate checks it before every vendor call made in the org's scope (the install org at `single`), so workflows, evaluations, ingestion and jobs stop at the cap too, with `org_budget_exceeded`.
- **Local models are never stopped.** A local provider costs nothing, so a reached cap does not refuse it, and a cap of `0` means "no paid calls". A paid primary the cap refuses fails over to a local fallback if the agent has one. A chat agent whose primary is local keeps answering on it, and every paid call that turn would make is refused, including a paid fallback, embeddings and tools. The same holds for the agent's own cap.
- **Who sets it.** A platform admin sets it with `PATCH /api/v1/admin/orgs/[id]` `{ settings: { quotas: { monthlyBudgetUsd } } }`. `quotas: null` removes it. At `multi` the write is refused (403, `details.reason: shared_settings_install_org_only`) unless it comes from the install org or an unbound admin API key, so a platform admin switched into a customer org cannot raise that org's cap. A fork's billing or plan code calls `writeOrgQuotas(orgId, quotas)` from `lib/tenancy/org-settings.ts` instead; that helper validates but does not check who is calling. The slice also holds the org's request cap, `requestsPerMinute` ([Rate limiting → Per-org request cap](../security/rate-limiting.md#per-org-request-cap)), and a write replaces the whole slice, so send both caps to keep both.
- **A malformed stored value fails open.** An unreadable cap is dropped with a warning and the org is limited only by its agents' budgets and the global cap. A failed org lookup is logged and skipped the same way.
- **A change takes effect at once in the process that made it.** The spend gate caches each org's cap for 30 seconds; the PATCH clears that org's entry, and other processes see the change within the 30 seconds. Code calling `writeOrgQuotas()` directly calls `forgetOrgCap(orgId)` from `lib/orchestration/llm/spend-caps.ts` afterwards for the same effect.
- **Every change is audited.** A caps write through `PATCH /api/v1/admin/orgs/[id]` records an `org.quotas.update` entry in the admin audit log (entity type `org`), with the caps it replaced and the caps it stored. `writeOrgQuotas()` called from a fork's own code writes no audit entry; that code owns its own record.
- **The agents list agrees.** Each agent's `_budget` in `GET /api/v1/admin/orchestration/agents` applies its org's cap as `checkBudget()` does, and carries `orgCapExceeded: true` when the org is over it.
- **Known limit: it can be overrun a little.** `withAgentBudgetLock` is keyed by agent, so two agents in one org can both pass the org check at the same time and each go over by up to one turn. The org's month-to-date total is also cached for 10 seconds per process, as the global one is, so spend made by another process is seen within that window. The global cap has the same bounds.

### Per-org usage

`GET /api/v1/admin/orchestration/costs/orgs?period=YYYY-MM` returns each org's spend, call count and tokens for one UTC calendar month, with its `quotas.monthlyBudgetUsd` and `utilisation` beside them (§110 t-790). It is the data a fork builds plans and invoices from. Plans, pricing and invoices stay the fork's. `period` defaults to the current month, the same period `checkBudget()` and the org cap use. `orgId` narrows the answer to one org.

- **It reads every tenant's spend, so at `multi` only the install org may ask.** A platform admin switched into a customer org gets 403 (`details.reason: shared_settings_install_org_only`), even when asking only for that org. An unbound admin API key is allowed, as the install org. This is the same rule the caps are written under.
- **The rollup runs in the system scope.** `getOrgUsage()` in `lib/orchestration/llm/cost-reports.ts` groups `AiCostLog` by `orgId` under `runAsSystem`, using the `(orgId, createdAt)` index. Inside the caller's org the `org_isolation` policy would hide every other org's rows. Orgs with no spend are listed with zeros.
- **Detached spend has its own bucket.** Rows with no org (an erased org's spend is kept and its `orgId` set to `NULL`) come back as `detached`, shown on the table as **No org**. They still count towards the global cap.
- **At `single` it is one install-org row**, totalling every row in the month, `NULL`-org rows included, and `detached` is `null`. The page hides the table then, since the summary cards already show that total.
- **Where it shows.** The costs page shows the per-org table when the endpoint returns more than one org, or any detached spend. If the endpoint refuses the caller, the table is not shown. The org detail page (`/admin/orgs/[id]`) asks for its own org (`?orgId=`) and shows month-to-date spend against the cap. In a customer org it says that usage can only be viewed from the install org.
- **A cap of `0` has no utilisation.** It means "no paid calls", so `utilisation` is `null`, and both the table and the org page say **Paid calls off**.

### What the chat user sees

The streaming handler names the cap that stopped the turn, checking the widest first:

| Code                     | Cap                                    |
| ------------------------ | -------------------------------------- |
| `global_budget_exceeded` | `globalMonthlyBudgetUsd`               |
| `org_budget_exceeded`    | `Org.settings.quotas.monthlyBudgetUsd` |
| `budget_exceeded`        | `AiAgent.monthlyBudgetUsd`             |

The words are the error registry's message and action for the code (`lib/orchestration/chat/error-messages.ts`), whether the turn was refused before it started or stopped part way by the provider gate. None names an amount, because the reader may be an embed visitor. Either way the `budget_exceeded` webhook fires, with `cap: 'agent' | 'org' | 'global'` in its payload; its `usedUsd` / `limitUsd` are still the agent's. A turn stopped part way also gets an error marker, so a reload shows the turn ended rather than an unanswered question. The red "Global monthly budget exceeded" banner on this page is driven by `GET /costs/alerts → globalCap.exceeded`.

### Per-turn cost cap

A separate mechanism caps the cost of a single chat turn (defense against a tool loop that fails to converge). Two layers:

- **Per-agent override** — `AiAgent.maxCostPerTurnUsd`, edited on the agent form. See [`agent-form.md`](./agent-form.md#per-turn-cost-cap-usd).
- **Org default** — `AiOrchestrationSettings.defaultMaxCostPerTurnUsd`, edited on the Settings page. Applies when an agent leaves its own cap blank.

When the accumulating turn cost crosses the resolved cap mid-loop, the streaming handler emits a distinct `budget_exceeded_per_turn` SSE event (separate from the monthly `budget_exceeded` code), persists the partial assistant message with `endedReason: 'budget_exceeded'`, and dispatches the `chat_budget_exceeded_per_turn` webhook so PagerDuty/alerting can fire independently of the monthly-overrun signal. See [`.context/orchestration/chat.md`](../orchestration/chat.md) for the loop semantics; the `agent_call` workflow step type mirrors the same guard with the `agent_call_budget_exceeded_per_turn` error.

## Global cap exceeded banner

When the platform-wide monthly budget cap is exceeded, `BudgetAlertsList` renders a prominent red banner at the top of the alerts section. In the install org it shows the current spend against the cap (e.g. "$542.00 of $500.00") and links to `/admin/orchestration/settings`. In a customer org at `multi` it says only that the platform has reached its budget, with no figures and no link, since every org's spend is not that org's to see and only the install org can change the cap. This is driven by `globalCap: GlobalCapStatus` returned alongside per-agent alerts from `GET /costs/alerts`. The `GlobalCapStatus` shape is `{ cap: number | null, spent: number | null, exceeded: boolean }`, produced by `getGlobalCapStatus()` in `cost-reports.ts`.

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

**OpenRouter refresh on page load:** The costs page calls `refreshFromOpenRouter()` before rendering, ensuring current-rate data is never more than 24h stale (no-op when cache is warm). Failures are negative-cached for 5 minutes — when OpenRouter is unreachable, subsequent calls inside that window short-circuit without re-issuing the (10-second timeout) fetch, so a remote outage doesn't compound into per-page-load slowdowns. After 5 minutes the next call retries; `force: true` bypasses both caches.

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

- [`.context/admin/orchestration-settings.md`](./orchestration-settings.md) — where default models and the global monthly cap are edited
- [`.context/admin/agent-form.md`](./agent-form.md) — per-agent monthly budget and per-turn cost cap fields
- [`.context/admin/provider-form.md`](./provider-form.md) — where API keys live
- [`.context/admin/workflow-builder.md`](./workflow-builder.md) — template banner, cost indicator
- [`.context/orchestration/chat.md`](../orchestration/chat.md) — streaming handler loop, budget enforcement semantics
- [`.context/orchestration/cost-estimation.md`](../orchestration/cost-estimation.md) — pre-run USD estimate service (empirical + heuristic)
- [`.context/orchestration/admin-api.md`](../orchestration/admin-api.md) — `/settings`, `/costs`, `/costs/summary`, `/costs/alerts`
- [`.context/orchestration/llm-providers.md`](../orchestration/llm-providers.md) — `getDefaultModelForTask` in `settings-resolver.ts`
- [`.context/api/orchestration-endpoints.md`](../api/orchestration-endpoints.md) — consumer HTTP reference
