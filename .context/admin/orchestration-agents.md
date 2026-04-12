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

| Column    | Source                              | Notes                                              |
| --------- | ----------------------------------- | -------------------------------------------------- |
| ☐ select  | Local `Set<string>` state           | Clears on page change / refetch                    |
| Name      | `agent.name`                        | Sort header. Links to edit page                    |
| Slug      | `agent.slug`                        | Monospace, muted                                   |
| Provider  | `agent.provider`                    |                                                    |
| Model     | `agent.model`                       |                                                    |
| Temp      | `agent.temperature.toFixed(2)`      | Right-aligned, tabular                             |
| Budget    | `agent.monthlyBudgetUsd`            | `—` when `null`                                    |
| Spend MTD | `GET /agents/:id/budget` per row    | **Lazy-fetched after paint** — shows `…` then `$X` |
| Status    | `agent.isActive`                    | `<Switch>` — optimistic PATCH, reverts on failure  |
| ⋯ Actions | Dropdown: Edit · Duplicate · Delete |                                                    |

### Bulk export

Header has an **Export selected** button enabled iff `selected.size > 0`. Clicking POSTs `/agents/export` with `{ agentIds: [...selected] }` and turns the response blob into a file download using the server's `Content-Disposition` filename (falls back to `agents-YYYY-MM-DD.json` if absent). There is intentionally **no bulk delete** — deletes are row-only to keep the blast radius of a mistaken selection tiny.

### Import

The **Import** button opens `<ImportAgentsDialog>`, which takes a `.json` bundle, parses it client-side, and POSTs `/agents/import` with `{ bundle, conflictMode }` where `conflictMode` is `"skip"` (default) or `"overwrite"`. On success the dialog shows `{ imported, skipped, warnings }` and the parent list refetches.

### Duplicate

Duplicate is a **client-side flow** — there is no `/duplicate` server route. `<DuplicateAgentDialog>` GETs the source agent, builds a `createAgentSchema`-shaped payload with a new name/slug (defaulting to `"<name> (copy)"` / `"<slug>-copy"`), sets `isActive: false` so the copy is dormant, and POSTs `/agents`. On success it `router.push`es to the new agent's edit page.

### Delete = soft delete

Row Delete sends `DELETE /agents/:id`, which sets `isActive=false` server-side. Conversations, cost logs, and history are preserved; the row can be reactivated by flipping its status Switch back on.

### Search / sort / pagination

- Search input uses a 300 ms debounce and appends `?q=` to the list fetch.
- Sort is **client-side** over the current page, limited to `name` and `createdAt`, because Phase 3's `listAgentsQuerySchema` has no `sortBy` / `sortOrder` params.
- Pagination delegates to the server (`?page=&limit=`) and mirrors `UserTable`'s prev/next buttons.

## Create & edit pages

Both are thin server shells that parallel-fetch the provider list and the aggregated model registry so the form's Model tab hydrates without a loading flicker. Missing providers/models → the form falls back to free-text inputs with an amber warning banner (see [`agent-form.md`](./agent-form.md)).

The edit page additionally fetches the agent itself via `GET /agents/:id`. A `null` response triggers `notFound()`, which renders the stock Next.js 404 page.

## Related

- [Agent form](./agent-form.md) — 5-tab form walkthrough, every FieldHelp copy, test-connection, capabilities tab
- [Orchestration dashboard](./orchestration-dashboard.md)
- [Admin API reference](../orchestration/admin-api.md)
- [Setup wizard](./setup-wizard.md) — shares `<AgentTestChat>` with the agent edit page
