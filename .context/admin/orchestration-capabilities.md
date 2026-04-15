# Capability management pages

Admin list/create/edit flows for `AiCapability`. Landed in Phase 4 Session 4.3. Capabilities are the **tools** an agent can call — function definitions, execution handlers, and safety gates.

**Pages**

| Route                                    | File                                                 | Role                                    |
| ---------------------------------------- | ---------------------------------------------------- | --------------------------------------- |
| `/admin/orchestration/capabilities`      | `app/admin/orchestration/capabilities/page.tsx`      | List table with search/filter/delete    |
| `/admin/orchestration/capabilities/new`  | `app/admin/orchestration/capabilities/new/page.tsx`  | Create shell, prefetches category hints |
| `/admin/orchestration/capabilities/[id]` | `app/admin/orchestration/capabilities/[id]/page.tsx` | Edit shell, `notFound()` on missing     |

All three are async server components that query Prisma directly (see `.context/architecture/data-fetching.md`). Fetch failures are tolerated — the list falls back to an empty state, the edit page falls back to `notFound()`, and real errors are surfaced via `logger.error` (never `console.*`).

## List page

**Table:** `components/admin/orchestration/capabilities-table.tsx` (client island, modelled on `agents-table.tsx`).

Columns:

| Column       | Source                                 | Notes                                                                    |
| ------------ | -------------------------------------- | ------------------------------------------------------------------------ |
| Name         | `capability.name`                      | Sort header. Links to edit page                                          |
| Slug         | `capability.slug`                      | Monospace, muted                                                         |
| Category     | `capability.category`                  | Sort header. Free-text, shown as plain text                              |
| Exec type    | `capability.executionType`             | `<Badge>` — blue/green/purple for `internal`/`api`/`webhook`             |
| Approval     | `capability.requiresApproval`          | Amber `Approval` badge when true, `—` otherwise                          |
| Rate / min   | `capability.rateLimit`                 | Right-aligned; `—` when `null` (no limit)                                |
| Agents using | `GET /capabilities/:id/agents` per row | **Lazy-fetched after paint** — shows `…` then `N agents`; `—` on failure |
| Status       | `capability.isActive`                  | `<Switch>` — optimistic PATCH, reverts on failure, shows inline error    |
| ⋯ Actions    | Dropdown: Edit · Delete                |                                                                          |

### Category filter

Header dropdown (`Select`) populated from a `new Set(rows.map(r => r.category))` plus an "all" option. A change refetches `/capabilities?category=...` server-side. Because the column is free-text on the backend, the dropdown is eventually-consistent — new categories show up after the next list refetch.

### Lazy "agents using it" count

Each visible row triggers a `GET /capabilities/:id/agents` after first paint (the same lazy-budget pattern used by `agents-table.tsx` for `spend MTD`). The response is the full agent projection, so the count is cached alongside the rows — the delete dialog reuses it to list exactly which agents will lose this tool.

If the per-row fetch throws, the cell renders `—` (never blocks the row, never propagates the error).

### Status toggle

Flipping the `isActive` Switch PATCHes `/capabilities/:id` with `{ isActive }` and optimistically updates the table. On failure the row reverts and an inline error banner appears above the table.

### Delete = soft delete

Row **Delete** opens `<DeleteCapabilityDialog>` (inline `AlertDialog`). The dialog:

1. Warns that this is a soft delete — the row stops being offered to agents on new chats, but its `AiCapabilityExecution` history is preserved.
2. Lists the agents currently using this capability (first 8, then "+N more"), pulled from the already-fetched `agentCounts` map.
3. Confirm sends `DELETE /capabilities/:id`, which flips `isActive = false` server-side. Reactivation is a flip of the status Switch.

### Search / sort / pagination

- Search input uses a 300 ms debounce and appends `?q=` to the list fetch.
- Sort is **client-side** over the current page, limited to `name` and `category` — the backend schema doesn't expose `sortBy`/`sortOrder` and `AiCapability` has no `createdAt` column.
- Pagination delegates to the server (`?page=&limit=`).

## Create & edit pages

**`new/page.tsx`** is a thin server shell that fetches the first 100 capabilities once to derive `availableCategories` (used by the form's Basic-tab category Select). Fetch failure falls back to an empty array — the form still works because admins can always enter a new category.

**`[id]/page.tsx`** fetches the capability, its agent-usage list, and the category hint list in parallel. A `null` capability triggers `notFound()`. Failures on the other two fetches degrade gracefully (empty chip card, empty dropdown).

Both render `<CapabilityForm>` — see [`capability-form.md`](./capability-form.md) for the 4-tab walkthrough.

## Additive endpoint

Session 4.3 adds **one** new route to the otherwise-locked Phase 3 HTTP surface:

**`GET /api/v1/admin/orchestration/capabilities/:id/agents`** — returns the minimal agent projections (`{ id, name, slug, isActive }`) for every agent linked via the `AiAgentCapability` pivot. Mirrors the additive `/agents/:id/capabilities` exception taken in Session 4.2. Used by the list page (agents-using count) and the edit page (delete warning).

Documented in [`admin-api.md`](../orchestration/admin-api.md).

## Related

- [Capability form](./capability-form.md) — 4-tab walkthrough, visual builder vs JSON editor, every FieldHelp copy
- [Agent form](./agent-form.md) — the Capabilities tab attaches/detaches rows from this list
- [Admin API reference](../orchestration/admin-api.md)
- [Capabilities (runtime)](../orchestration/capabilities.md)
