# Admin Orchestration Dashboard

Landing page for the AI Orchestration admin area. Thin async server component that fetches summary endpoints in parallel and renders a streamlined three-section layout: operational stat cards, trends/activity, and conditional budget alerts.

**Route:** `/admin/orchestration`
**Page:** `app/admin/orchestration/page.tsx`
**Layout:** `app/admin/orchestration/layout.tsx` — minimal pass-through; auth and sidebar come from the parent `app/admin/layout.tsx`.

## Layout

```
┌────────────────────────────────────────────────────────┐
│ AI Orchestration                     [Setup Guide]     │
│ Operational overview — agents, spend, and activity.    │
├────────────────────────────────────────────────────────┤
│ Budget alerts (only when alerts exist)                 │
├────────────────────────────────────────────────────────┤
│ [Agents↗] [Today's Spend↗] [Requests↗] [Error Rate↗]  │
│  (each card is a clickable link to its detail page)    │
├──────────────────────┬─────────────────────────────────┤
│  7-day spend trend   │  Recent activity                │
│  (chart)             │  (unified feed: conversations,  │
│                      │   executions, errors inline)    │
├──────────────────────┤                                 │
│  Top capabilities    │                                 │
│  (bar chart)         │                                 │
└──────────────────────┴─────────────────────────────────┘
```

### Design principles

- **Operational focus**: stat cards show live signals (spend, requests, error rate) rather than static inventory counts (workflows, total conversations) that rarely change.
- **No duplicate navigation**: Quick Actions section was removed — the sidebar already provides all navigation links.
- **Unified timeline**: Recent Activity and Recent Errors merged into a single feed. Error items are visually distinguished with a red icon and "error" badge.
- **Clickable cards**: Each stat card links to its detail page (agents → agents list, spend → costs, requests → conversations, error rate → analytics).

## Data sources

Every fetch is **null-safe**. A failing API renders an empty state, never throws.

| Component              | Endpoint                                                 | Notes                                       |
| ---------------------- | -------------------------------------------------------- | ------------------------------------------- |
| Agents stat card       | `GET /admin/orchestration/agents?page=1&limit=1`         | `getPaginatedTotal()` extracts `meta.total` |
| Today's spend card     | `GET /admin/orchestration/costs/summary`                 | `getCostSummary()` → `totals.today`         |
| Today's requests card  | `GET /admin/orchestration/observability/dashboard-stats` | `getDashboardStats()` → `todayRequests`     |
| Error rate card        | `GET /admin/orchestration/observability/dashboard-stats` | `getDashboardStats()` → `errorRate`         |
| Budget alerts banner   | `GET /admin/orchestration/costs/alerts`                  | `getBudgetAlerts()`                         |
| 7-day spend trend      | `GET /admin/orchestration/costs/summary`                 | `getCostSummary()` → `trend.slice(-7)`      |
| Top capabilities       | `GET /admin/orchestration/observability/dashboard-stats` | `getDashboardStats()` → `topCapabilities`   |
| Activity feed (convos) | `GET /admin/orchestration/conversations?limit=10`        | `getActivityFeed()`                         |
| Activity feed (execs)  | `GET /admin/orchestration/executions?limit=10`           | `getActivityFeed()` (501 stub → empty list) |
| Activity feed (errors) | `GET /admin/orchestration/observability/dashboard-stats` | `getDashboardStats()` → `recentErrors`      |

All calls go through `serverFetch()` + `parseApiResponse()` — never raw `fetch`. Cookie forwarding is automatic.

## Error handling

Each helper wraps its fetch in `try/catch` and returns `null` on any failure. Failures are logged with `logger.error(message, err, { ...meta })`. The page renders each component with `null`-safe props (em-dashes for stats, empty-state cards for the activity feed, nothing for budget alerts).

Do **not** throw from a helper — the entire page would error-boundary and the user would see nothing.

## Sub-components

All live under `components/admin/orchestration/`. Server components unless flagged.

- `dashboard-stats-cards.tsx` — four clickable stat cards (Agents, Spend, Requests, Error Rate); `null` values render as `—`; cards link to their detail pages; error rate > 5% renders in red.
- `dashboard-activity-feed.tsx` — unified timeline merging conversations, executions, and errors; error items show red icon + "error" badge; sorted newest-first.
- `budget-alerts-banner.tsx` — returns `null` when no alerts so layout stays stable.
- `top-capabilities-panel.tsx` — ranked bar chart of most-used capabilities.
- `costs/cost-trend-chart.tsx` — 7-day stacked area chart by tier (client component).
- `setup-wizard-launcher.tsx` — client island; renders `Setup Guide` button and lazy-mounts the wizard.

### Removed from dashboard (still exist as components)

- `orchestration-stats-cards.tsx` — replaced by `dashboard-stats-cards.tsx`.
- `observability-stats-cards.tsx` — merged into `dashboard-stats-cards.tsx`.
- `recent-activity-list.tsx` — replaced by `dashboard-activity-feed.tsx`.
- `recent-errors-panel.tsx` — merged into `dashboard-activity-feed.tsx`.
- `quick-actions.tsx` — removed from dashboard (sidebar covers this).

## Adding a new stat card

1. Add a new `getX()` helper in `page.tsx` that returns `Promise<T | null>`.
2. Append it to the `Promise.all([...])` destructure.
3. Extend `DashboardStatsCardsProps` with the new prop and render a new `<StatCard>` inside `dashboard-stats-cards.tsx`.

Keep stat cards cheap — they run on every page render and are not cached.

## Related

- [Setup Wizard](./setup-wizard.md)
- [`.context/orchestration/admin-api.md`](../orchestration/admin-api.md) — HTTP surface consumed by this page
- [`.context/orchestration/overview.md`](../orchestration/overview.md) — system overview
