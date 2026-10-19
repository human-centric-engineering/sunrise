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

No fetch throws: each is `loadServerData()` from `lib/api/server-load.ts`, and a panel whose load failed renders `<LoadFailedNotice>` in its place.

| Component              | Endpoint                                                        | Notes                                                                                                                                                 |
| ---------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Agents stat card       | `GET /admin/orchestration/agents?isSystem=false&page=1&limit=1` | `getPaginatedTotal()` extracts `meta.total`; the org's own agents only, as setup state counts them, so a new org does not open on its platform agents |
| Today's spend card     | `GET /admin/orchestration/costs/summary`                        | `totals.today`                                                                                                                                        |
| Today's requests card  | `GET /admin/orchestration/observability/dashboard-stats`        | `todayRequests`                                                                                                                                       |
| Error rate card        | `GET /admin/orchestration/observability/dashboard-stats`        | `errorRate`                                                                                                                                           |
| Budget alerts banner   | `GET /admin/orchestration/costs/alerts`                         | `alerts`                                                                                                                                              |
| 7-day spend trend      | `GET /admin/orchestration/costs/summary`                        | `trend.slice(-7)`                                                                                                                                     |
| Top capabilities       | `GET /admin/orchestration/observability/dashboard-stats`        | `topCapabilities`                                                                                                                                     |
| Activity feed (convos) | `GET /admin/orchestration/conversations?limit=10`               | `getActivityFeed()`                                                                                                                                   |
| Activity feed (execs)  | `GET /admin/orchestration/executions?limit=10`                  | `getActivityFeed()`                                                                                                                                   |
| Activity feed (errors) | `GET /admin/orchestration/observability/dashboard-stats`        | `recentErrors`                                                                                                                                        |

All calls go through `loadServerData()`, which uses `serverFetch()` — never raw `fetch`. Cookie forwarding is automatic.

## Error handling

`loadServerData()` logs every failure; the page has no catch blocks of its own. What a failed load renders:

| Data that failed                   | Renders                                                         |
| ---------------------------------- | --------------------------------------------------------------- |
| A stat card's figure               | "—" on that card (already reads as unknown, not zero)           |
| Budget alerts                      | `<LoadFailedNotice what="budget alerts">` in the banner's place |
| Active quarantines (platform only) | A notice in the panel's place                                   |
| Cost summary                       | A notice in the spend chart's place                             |
| Dashboard stats                    | A notice in the top-capabilities panel's place                  |
| Conversations, executions or stats | A notice in the activity feed's place                           |

The budget banner and the quarantine panel are why this matters: both are absent when all is well, so rendering them from a failed load would show the all-clear. The activity feed fails as a whole when any of its three sources does, for the same reason — a feed missing executions reads as "no recent runs".

Do **not** use `requireServerData()` here: no one panel is the page's reason to exist, so one failing endpoint must not take the whole dashboard down.

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

## Adding a new stat card

1. Add a new `getX()` helper in `page.tsx` that returns `Promise<T | null>`.
2. Append it to the `Promise.all([...])` destructure.
3. Extend `DashboardStatsCardsProps` with the new prop and render a new `<StatCard>` inside `dashboard-stats-cards.tsx`.

Keep stat cards cheap — they run on every page render and are not cached.

## Related

- [Setup Wizard](./setup-wizard.md)
- [`.context/orchestration/admin-api.md`](../orchestration/admin-api.md) — HTTP surface consumed by this page
- [`.context/orchestration/overview.md`](../orchestration/overview.md) — system overview
