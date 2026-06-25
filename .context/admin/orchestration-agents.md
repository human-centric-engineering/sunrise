# Agent management pages

Admin list/create/edit flows for `AiAgent`. Landed in Phase 4 Session 4.2.

**Pages**

| Route                              | File                                           | Role                                |
| ---------------------------------- | ---------------------------------------------- | ----------------------------------- |
| `/admin/orchestration/agents`      | `app/admin/orchestration/agents/page.tsx`      | List table, bulk export, delete     |
| `/admin/orchestration/agents/new`  | `app/admin/orchestration/agents/new/page.tsx`  | Create shell, prefetches providers  |
| `/admin/orchestration/agents/[id]` | `app/admin/orchestration/agents/[id]/page.tsx` | Edit shell, `notFound()` on missing |

All three are async server components using `serverFetch()` + `parseApiResponse()`. They never throw — any upstream fetch failure falls back to an empty state or `notFound()`, and real errors are logged with `logger.error`.

## List page

**Table:** `components/admin/orchestration/agents-table.tsx` (client island, modelled on `components/admin/user-table.tsx`).

**Toolbar:**

- **Scope segmented control** — pill toggle styled like the knowledge base scope picker. Three options: `All` (default, no filter), `System` (sends `isSystem=true`), `App` (sends `isSystem=false`). Choice persists per-user via `useLocalStorage` under `agents-table-kind-tab`.
- **Search input** — debounced 300ms, hits the `q` query param. Searches name / slug / description.
- **Profile filter dropdown** — populated from `/agent-profiles` on mount. Options: `All profiles` (default), `Unassigned` (sends `profileId=none`), then one row per profile (with a Shield icon prefix for system profiles).
- **Group by profile toggle** — `<Layers>`-iconed button. When active, the current page's rows bucket by `profile?.id ?? '__unassigned__'` into collapsible sections (Unassigned sinks to the bottom). Toggle state persists under `agents-table-group-by-profile`; per-bucket collapse state under `agents-table-collapsed-buckets`. Grouping is purely a visual reframe — pagination still applies to the underlying page.

Columns:

| Column      | Source                              | Notes                                                                                                  |
| ----------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| ☐ select    | Local `Set<string>` state           | Clears on page change / refetch                                                                        |
| Name        | `agent.name`                        | **Sortable** (page-local). Links to edit page. Visibility badge inline. Description below              |
| Profile     | `agent.profile`                     | Badge linking to the profile detail page. Shield icon for system profiles. `—` for unassigned.         |
| Tools       | `agent._count.capabilities`         | Inline from list API. Links to edit page when > 0                                                      |
| Chats       | `agent._count.conversations`        | **Sortable** (page-local)                                                                              |
| Model       | `agent.provider` + `agent.model`    | Combined: `provider / model`                                                                           |
| Budget      | `agent.monthlyBudgetUsd`            | `—` when `null`                                                                                        |
| Spend MTD   | `agent._budget.spent`               | **Sortable** (page-local). Inline from list API (batch `groupBy`). `—` when no budget                  |
| Last active | `agent.lastActiveAt`                | **Sortable** (page-local). Relative time (`2h ago`). Absolute timestamp in tooltip. `Never` when null. |
| Created     | `agent.createdAt`                   | **Sortable** (page-local). Relative time (`3d ago`). Creator name in tooltip via `agent.creator`       |
| Status      | `agent.isActive`                    | `<Switch>` — optimistic PATCH, reverts on failure                                                      |
| ⋯ Actions   | Dropdown: Edit · Duplicate · Delete |                                                                                                        |

### Default sort vs explicit sort

The server returns rows in **natural-importance order**: `[isSystem asc, lastActiveAt desc nulls last, createdAt desc]`. The default UI sort field is `'default'` — the client renders rows exactly as the API delivered them.

Clicking any sortable column header switches the field away from `'default'` and the table runs a single-pass client-side re-sort that **preserves the bespoke-first split** (system agents stay below bespoke agents regardless of which column was clicked). The "Sort this page by …" tooltip wording flags that the sort applies only to the current page — pagination is server-driven, not re-sorted.

`agent.lastActiveAt` is bumped in three places (`touch-last-active.ts` helper):

- `lib/orchestration/llm/cost-tracker.ts` — after a cost-log row is written for the agent.
- `lib/orchestration/chat/streaming-handler.ts` — when a new conversation is created.
- `lib/orchestration/inbound/conversation-resolver.ts` — on inbound conversation create/update.

The helper is fire-and-forget and swallows both async rejections and synchronous throws — a missed bump just means the agent ranks slightly lower on the next load.

### Name cell enrichments

- **Visibility badge** — `public` and `invite_only` agents show an outline badge (`Public` with Eye icon, `Invite` with Link2 icon) next to the name. `internal` agents show no badge (default).
- **System badge** — `isSystem: true` agents (mcp-system, pattern-advisor, the six seeded evaluation judges, etc.) show a `Shield`-iconed secondary badge. Cannot be deleted or deactivated.
- **Judge badge** — `kind: 'judge'` agents show an amber outline badge with the `Scale` icon. Judge agents are driven by the evaluation worker (and the manual-session scorer) to score AI responses. Their `systemInstructions` IS the rubric. See `.context/orchestration/evaluations.md` for the agents-as-judges architecture.
- **Description subtitle** — when `agent.description` is set, a truncated muted line appears below the name.

### Kind discriminator

`AiAgent.kind` (`'chat' | 'judge'`) controls the agent's role. The list page's API call (`GET /api/v1/admin/orchestration/agents`) accepts an optional `?kind=chat|judge` filter; when the parameter is omitted, every kind is returned and the badges above let an operator tell them apart.

- The run-create form's **subject** picker calls `?kind=chat` so judges never appear as candidates to be evaluated.
- The run-create form's **metric / judge** picker calls `?kind=judge` so the available judges are shown.
- The agents list page passes no filter, so all kinds show with badges.

Judges are created via the agent form with `?kind=judge` in the URL (the "Create custom judge" CTA on the run-create form passes this). `kind` is set at create time only — see `.context/admin/agent-form.md` § "Agent kind: chat vs judge".

### Bulk export

Header has an **Export selected** button enabled iff `selected.size > 0`. Clicking POSTs `/agents/export` with `{ agentIds: [...selected] }` and turns the response blob into a file download using the server's `Content-Disposition` filename (falls back to `agents-YYYY-MM-DD.json` if absent).

The bundle carries the full agent configuration plus, **by slug**, the attached capabilities, the linked **profile** (`profileSlug`), and granted **knowledge tags** (`knowledgeTagSlugs`). Server-owned fields (`id`, `createdBy`, timestamps) are stripped for portability. Agent→**document** grants are intentionally not carried — documents have no stable cross-environment key (tracked in #338).

### Import

The **Import** button opens `<ImportAgentsDialog>`, which takes a `.json` bundle, parses it client-side, and POSTs `/agents/import` with `{ bundle, conflictMode }` where `conflictMode` is `"skip"` (default) or `"overwrite"`. The server rejects bundles containing duplicate slugs with a 400 before starting any DB work. On success the dialog shows `{ imported, overwritten, skipped, warnings }` and the parent list refetches.

Reference re-linking on import differs by relation: unknown **capability** slugs are collected into `warnings` and skipped (superset-environment tolerance), but a **profile** or **knowledge-tag** slug that doesn't exist in the target environment **fails the whole import** (single transaction → full rollback) with an actionable 400 naming the missing reference — silently dropping an agent's profile inheritance or knowledge scoping would change its behaviour. Older bundles (pre-dating these fields) still import: every added field is optional/defaulted.

### Duplicate (Clone)

Duplicate uses `<DuplicateAgentDialog>`, which receives the source agent as a prop and POSTs to `POST /agents/:id/clone` with optional `{ name, slug }` overrides (defaulting to `"<name> (Copy)"` / `"<slug>-copy"`). The server-side clone copies all fields and capability bindings in a single transaction. The clone always starts with `isActive: false` so the admin can review it before going live. The dialog validates the slug format client-side using `slugSchema` (lowercase alphanumeric with single hyphens). On success it `router.push`es to the new agent's edit page.

### Delete = soft delete

Row Delete sends `DELETE /agents/:id`, which sets `isActive=false` server-side. Conversations, cost logs, and history are preserved; the row can be reactivated by flipping its status Switch back on.

### Search / sort / pagination

- Search input uses a 300 ms debounce and appends `?q=` to the list fetch.
- Sort is **client-side** over the current page, limited to `name` and `createdAt`, because Phase 3's `listAgentsQuerySchema` has no `sortBy` / `sortOrder` params. Changing sort resets to page 1.
- Pagination delegates to the server (`?page=&limit=`) and mirrors `UserTable`'s prev/next buttons.
- The "Select all" checkbox applies to the current page only (indicated by its `title` attribute).

## Compare agents

`/admin/orchestration/agents/compare?a=<idA>&b=<idB>` — side-by-side comparison view for two agents.

**Entry points:**

- From the list page, select exactly two rows and click the **Compare** header button (enabled only when `selected.size === 2`).
- Direct URL with both `a` and `b` query params.

**Missing or partial query params** render a short explainer with a link back to the list. No `notFound()` — the page exists for any logged-in admin.

**Shell:** `app/admin/orchestration/agents/compare/page.tsx` is an async server component that only parses the query params and mounts `<AgentComparisonView agentIdA={a} agentIdB={b} />` (the comparison itself is a client island).

**Data:** `AgentComparisonView` fetches `GET /agents/compare?agentIds=<idA>,<idB>` on mount and expects `{ agents: [AgentStats, AgentStats] }`. The comma-separated `agentIds` form is required — single-param `?a=&b=` is the URL contract, `?agentIds=` is the API contract.

**Layout:** three Cards rendered in a `grid-cols-[1fr_1fr_1fr]` row (label column, agent A column, agent B column):

| Card                   | Rows                                                                  | Highlighting (`better`)     |
| ---------------------- | --------------------------------------------------------------------- | --------------------------- |
| **Configuration**      | Model, Provider, Capabilities                                         | Capabilities → higher       |
| **Performance**        | Total Cost ($), LLM Calls, Input Tokens, Output Tokens, Conversations | Cost + Input Tokens → lower |
| **Evaluation Results** | Total Evaluations, Completed                                          | Completed → higher          |

Values that "win" on the `better` direction render in green. Ties and missing numbers are uncoloured. The `ComparisonRow` helper renders `—` for `null` values so rows stay aligned when an agent has no telemetry yet.

**Back button:** top-left "Back to agents" link returns to the list without preserving selection state.

## Create & edit pages

Both are thin server shells that parallel-fetch the provider list and the aggregated model registry so the form's Model tab hydrates without a loading flicker. Missing providers/models → the form falls back to free-text inputs with an amber warning banner (see [`agent-form.md`](./agent-form.md)).

The edit page additionally fetches the agent itself via `GET /agents/:id`. A `null` response triggers `notFound()`, which renders the stock Next.js 404 page.

The edit page also prefetches the agent's evaluation-quality trend via `GET /agents/:id/evaluation-trend` and renders an `EvaluationTrendChart` (recharts `LineChart`) above the form. The chart hides itself when fewer than 2 completed evaluations exist for the agent — a single point isn't a trend. See [`evaluation-metrics.md`](../orchestration/evaluation-metrics.md) for the per-metric rubric and the noisy-scores caveat.

## Related

- [Agent form](./agent-form.md) — 7-tab form walkthrough, every FieldHelp copy, test-connection, capabilities tab, version history
- [Orchestration dashboard](./orchestration-dashboard.md)
- [Admin API reference](../orchestration/admin-api.md)
- [Setup wizard](./setup-wizard.md) — shares `<AgentTestChat>` with the agent edit page
