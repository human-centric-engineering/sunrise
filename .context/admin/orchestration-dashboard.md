# Admin Orchestration Dashboard

Landing page for the AI Orchestration admin area. Thin async server component that fans out to a handful of summary endpoints and lays them out as stats cards, a budget-alerts strip, quick actions, and a recent-activity feed.

**Route:** `/admin/orchestration`
**Page:** `app/admin/orchestration/page.tsx`
**Layout:** `app/admin/orchestration/layout.tsx` — minimal pass-through; auth and sidebar come from the parent `app/admin/layout.tsx`.

## Layout

```
┌────────────────────────────────────────────────────────┐
│ AI Orchestration                   [ Setup Guide ]    │
├────────────────────────────────────────────────────────┤
│ [Agents] [Workflows] [Today $] [Conversations]         │
├────────────────────────────────────────────────────────┤
│ Budget alerts (only when alerts exist)                 │
├────────────────────────────────────────────────────────┤
│ Quick actions                                          │
│ [Create Agent] [Create Workflow] [Upload Docs] [Chat]  │
├────────────────────────────────────────────────────────┤
│ Recent activity (last 10, merged + sorted)             │
└────────────────────────────────────────────────────────┘
```

## Data sources

Every fetch is **null-safe**. A failing API renders an empty state, never throws.

| Component                       | Endpoint                                                | Helper                                                   |
| ------------------------------- | ------------------------------------------------------- | -------------------------------------------------------- |
| Agents stat card                | `GET /admin/orchestration/agents?page=1&limit=1`        | `getPaginatedTotal()`                                    |
| Workflows stat card             | `GET /admin/orchestration/workflows?page=1&limit=1`     | `getPaginatedTotal()`                                    |
| Today's spend stat card         | `GET /admin/orchestration/costs/summary`                | `getCostSummary()`                                       |
| Conversations stat card         | `GET /admin/orchestration/conversations?page=1&limit=1` | `getPaginatedTotal()`                                    |
| Budget alerts banner            | `GET /admin/orchestration/costs/alerts`                 | `getBudgetAlerts()`                                      |
| Recent activity (conversations) | `GET /admin/orchestration/conversations?limit=10`       | `getRecentActivity()`                                    |
| Recent activity (executions)    | `GET /admin/orchestration/executions?limit=10`          | `getRecentActivity()` (501 stub — treated as empty list) |

All calls go through `serverFetch()` + `parseApiResponse()` — never raw `fetch`. Cookie forwarding is automatic.

## Error handling

Each helper wraps its fetch in `try/catch` and returns `null` on any failure. Failures are logged with `logger.error(message, err, { ...meta })`. The page then renders each component with `null`-safe props (em-dashes for stats, empty-state cards for the activity feed, nothing at all for the budget alerts banner).

Do **not** throw from a helper — the entire page would error-boundary and the user would see nothing. The `overview/page.tsx` pattern is the reference.

## Sub-components

All live under `components/admin/orchestration/`. Server components unless flagged.

- `orchestration-stats-cards.tsx` — four stat cards; `null` values render as `—`.
- `budget-alerts-banner.tsx` — returns `null` when no alerts so layout stays stable.
- `recent-activity-list.tsx` — merges conversations + executions, sorts newest-first.
- `quick-actions.tsx` — four `<Link>`s styled as buttons, no client state.
- `setup-wizard-launcher.tsx` — client island; renders the `Setup Guide` button and lazy-mounts `setup-wizard.tsx` in a Dialog on click. See [`setup-wizard.md`](./setup-wizard.md).

## Adding a new stat card

1. Add a new `getX()` helper in `page.tsx` that returns `Promise<T | null>`.
2. Append it to the `Promise.all([...])` destructure.
3. Extend `OrchestrationStatsCardsProps` with the new prop and render a new `<StatCard>` inside `orchestration-stats-cards.tsx`.

Keep stat cards cheap — they run on every page render and are not cached.

## Related

- [Setup Wizard](./setup-wizard.md)
- [`.context/orchestration/admin-api.md`](../orchestration/admin-api.md) — HTTP surface consumed by this page
- [`.context/orchestration/overview.md`](../orchestration/overview.md) — system overview
