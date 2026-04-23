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

Columns:

| Column    | Source                              | Notes                                                                       |
| --------- | ----------------------------------- | --------------------------------------------------------------------------- |
| ☐ select  | Local `Set<string>` state           | Clears on page change / refetch                                             |
| Name      | `agent.name`                        | Sort header. Links to edit page. Visibility badge inline. Description below |
| Tools     | `agent._count.capabilities`         | Inline from list API. Links to edit page when > 0                           |
| Chats     | `agent._count.conversations`        | Inline from list API                                                        |
| Model     | `agent.provider` + `agent.model`    | Combined: `provider / model`                                                |
| Budget    | `agent.monthlyBudgetUsd`            | `—` when `null`                                                             |
| Spend MTD | `agent._budget.spent`               | Inline from list API (batch `groupBy`). `—` when no budget                  |
| Created   | `agent.createdAt`                   | Relative time (`3d ago`). Creator name in tooltip via `agent.creator`       |
| Status    | `agent.isActive`                    | `<Switch>` — optimistic PATCH, reverts on failure                           |
| ⋯ Actions | Dropdown: Edit · Duplicate · Delete |                                                                             |

### Name cell enrichments

- **Visibility badge** — `public` and `invite_only` agents show an outline badge (`Public` with Eye icon, `Invite` with Link2 icon) next to the name. `internal` agents show no badge (default).
- **Description subtitle** — when `agent.description` is set, a truncated muted line appears below the name.

### Bulk export

Header has an **Export selected** button enabled iff `selected.size > 0`. Clicking POSTs `/agents/export` with `{ agentIds: [...selected] }` and turns the response blob into a file download using the server's `Content-Disposition` filename (falls back to `agents-YYYY-MM-DD.json` if absent).

### Import

The **Import** button opens `<ImportAgentsDialog>`, which takes a `.json` bundle, parses it client-side, and POSTs `/agents/import` with `{ bundle, conflictMode }` where `conflictMode` is `"skip"` (default) or `"overwrite"`. On success the dialog shows `{ imported, skipped, warnings }` and the parent list refetches.

### Duplicate (Clone)

Duplicate uses `<DuplicateAgentDialog>`, which receives the source agent as a prop and POSTs to `POST /agents/:id/clone` with optional `{ name, slug }` overrides (defaulting to `"<name> (Copy)"` / `"<slug>-copy"`). The server-side clone copies all fields and capability bindings in a single transaction. The clone preserves `isActive` from the source (it is **not** forced to inactive). On success it `router.push`es to the new agent's edit page.

### Delete = soft delete

Row Delete sends `DELETE /agents/:id`, which sets `isActive=false` server-side. Conversations, cost logs, and history are preserved; the row can be reactivated by flipping its status Switch back on.

### Search / sort / pagination

- Search input uses a 300 ms debounce and appends `?q=` to the list fetch.
- Sort is **client-side** over the current page, limited to `name` and `createdAt`, because Phase 3's `listAgentsQuerySchema` has no `sortBy` / `sortOrder` params.
- Pagination delegates to the server (`?page=&limit=`) and mirrors `UserTable`'s prev/next buttons.

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

## Related

- [Agent form](./agent-form.md) — 7-tab form walkthrough, every FieldHelp copy, test-connection, capabilities tab, version history
- [Orchestration dashboard](./orchestration-dashboard.md)
- [Admin API reference](../orchestration/admin-api.md)
- [Setup wizard](./setup-wizard.md) — shares `<AgentTestChat>` with the agent edit page
