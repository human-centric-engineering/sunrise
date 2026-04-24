# Analytics dashboard

Admin page at `/admin/orchestration/analytics`. Surfaces usage engagement, popular topics, unanswered questions, feedback (thumbs up/down), and content gaps across agents. This doc covers the **admin UI only** — the query functions that produce the metrics live in [`.context/orchestration/analytics.md`](../orchestration/analytics.md).

> **Source of truth:** `app/admin/orchestration/analytics/` + `components/admin/orchestration/analytics/`. Update this doc when those files change.

**Page shell:** `@/app/admin/orchestration/analytics/page.tsx` — async server component.
**Client island:** `@/components/admin/orchestration/analytics/analytics-view.tsx` — single file, no siblings.

## Layout

The view is a **single vertical scroll** (not tabbed). Each section reads from exactly one backing endpoint.

```
┌─────────────────────────────────────────────────────────────────┐
│ Filters  ·  From │ To │ Agent                                   │
├─────────────────────────────────────────────────────────────────┤
│ Engagement cards  (5)                                           │
│   Conversations │ Messages │ Unique Users │ Avg Depth │ Return. │
├─────────────────────────────────────────────────────────────────┤
│ Conversations Over Time  (bar chart — only if ≥2 days of data)  │
├─────────────────────────────────────────────────────────────────┤
│ Feedback Summary                                                │
│   Overall satisfaction · Per-agent table                        │
│   Recent negative (10): User Asked │ Agent Response │ Date      │
├──────────────────────────────┬──────────────────────────────────┤
│ Popular Topics (top 15)      │ Content Gaps (top 15)            │
├──────────────────────────────┴──────────────────────────────────┤
│ Unanswered Questions (top 20)                                   │
└─────────────────────────────────────────────────────────────────┘
```

### Section data bindings

| Section                  | Backing endpoint                                           | Empty state                                                                   |
| ------------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Engagement cards         | `GET /analytics/engagement` → `metrics`                    | Cards render with an em-dash (`—`) when `null`                                |
| Conversations Over Time  | `GET /analytics/engagement` → `metrics.conversationsByDay` | Hidden entirely if `length <= 1`                                              |
| Feedback Summary         | `GET /analytics/feedback` → `feedback`                     | Card hidden if `null`; "No feedback ratings in this period." if `total === 0` |
| Per-agent feedback table | same → `feedback.byAgent[]`                                | Table hidden if empty array                                                   |
| Recent Negative Feedback | same → `feedback.recentNegative[]` (sliced to 10)          | Sub-section hidden if empty array                                             |
| Popular Topics           | `GET /analytics/topics` → `topics[]` (sliced to 15)        | "No topic data yet."                                                          |
| Content Gaps             | `GET /analytics/content-gaps` → `gaps[]` (sliced to 15)    | "No content gaps detected."                                                   |
| Unanswered Questions     | `GET /analytics/unanswered` → `questions[]` (sliced to 20) | "No unanswered questions found."                                              |

All six server fetches (five analytics endpoints plus `GET /agents` for the filter dropdown) run in parallel via `Promise.all` in the page shell. Each is wrapped in try/catch and returns `null` on failure — the page never throws; the affected section just degrades to its empty state.

## Filters

Three URL-driven controls on the `<Card data-testid="analytics-filters">` header. The client island mutates `window.location.search` via `router.push(...)`; the server shell re-reads `searchParams` and re-runs the fetches.

| Control | Param     | Default                    | Notes                                                                          |
| ------- | --------- | -------------------------- | ------------------------------------------------------------------------------ |
| From    | `from`    | 30 days ago (`YYYY-MM-DD`) | `<input type="date">` — defaults computed in `getAnalyticsDefaultDateInputs()` |
| To      | `to`      | today (`YYYY-MM-DD`)       | Inclusive of end date (resolved to end-of-day server-side)                     |
| Agent   | `agentId` | `__all__` (unset)          | `Select` — `__all__` sentinel clears the param                                 |

Filter params are pass-through: the page forwards `from` / `to` / `agentId` verbatim to every analytics endpoint. Agent list comes from `GET /agents` and silently becomes `[]` on failure (dropdown shows only "All agents").

### No date-default mismatch

The shell uses `thirtyDaysAgo` / `today` only to populate the filter **inputs** when the URL has no `from` / `to`. It does **not** inject those defaults into the API query — the endpoints compute their own server-side defaults (also 30d / now) via `analyticsQuerySchema` in `@/lib/validations/orchestration`. Keep the two defaults aligned when changing either.

## Data sources

Every route is `withAdminAuth` + `adminLimiter` + `validateQueryParams(analyticsQuerySchema)`. Same query shape across all five: `from`, `to` (`YYYY-MM-DD`), `agentId` (CUID), `limit` (1–100, default 20).

| Section              | Method & path                                            | Route file                                                       |
| -------------------- | -------------------------------------------------------- | ---------------------------------------------------------------- |
| Engagement           | `GET /api/v1/admin/orchestration/analytics/engagement`   | `app/api/v1/admin/orchestration/analytics/engagement/route.ts`   |
| Popular Topics       | `GET /api/v1/admin/orchestration/analytics/topics`       | `app/api/v1/admin/orchestration/analytics/topics/route.ts`       |
| Unanswered Questions | `GET /api/v1/admin/orchestration/analytics/unanswered`   | `app/api/v1/admin/orchestration/analytics/unanswered/route.ts`   |
| Feedback Summary     | `GET /api/v1/admin/orchestration/analytics/feedback`     | `app/api/v1/admin/orchestration/analytics/feedback/route.ts`     |
| Content Gaps         | `GET /api/v1/admin/orchestration/analytics/content-gaps` | `app/api/v1/admin/orchestration/analytics/content-gaps/route.ts` |

Endpoint constants live in `@/lib/api/endpoints` as `API.ADMIN.ORCHESTRATION.ANALYTICS_{ENGAGEMENT,TOPICS,UNANSWERED,FEEDBACK,CONTENT_GAPS}`.

## Display quirks

- **Numbers** — `formatNumber()` uses `toLocaleString()`; shows em-dash for `null`/`undefined`.
- **Percents** — `formatPercent()` multiplies by 100, one decimal place, em-dash for null.
- **Avg Depth** — `engagement.avgMessagesPerConversation.toFixed(1)` (not `formatNumber`).
- **Bar chart** — heights computed client-side: `(day.count / maxDayCount) * 100%`, with a 4px `min-height` for non-zero days so single-request days still register.
- **Truncation** — topic / gap / message cells cap at `max-w-[300px]` with `truncate`. Full content lives in the backing conversation/message rows.
- **No export button** — there is no CSV/JSON export on the analytics page. If you're adding one, wire it through a new endpoint; do not export client-side from props.

## Contextual help (`<FieldHelp>`)

Six `<FieldHelp>` popovers match the voice in [`.context/ui/contextual-help.md`](../ui/contextual-help.md):

- **Avg Depth** — "Average messages per conversation"
- **Returning Users** — "Percentage of users who started more than one conversation"
- **Popular Topics** — "Most frequently asked user messages, grouped case-insensitively. Shows the top 15 topics in the selected period."
- **Feedback Summary** — "Based on thumbs-up / thumbs-down ratings on individual agent responses. Satisfaction rate = thumbs-up / total ratings."
- **Content Gaps** — "Topics where a high proportion of questions go unanswered, indicating missing knowledge base content. Based on the 500 most recent conversations in the selected period using heuristic phrase detection."
- **Unanswered Questions** — "Conversations where the assistant responded with hedging phrases like 'I don't know', 'I'm not sure', or 'I cannot find'. Uses exact phrase matching to detect uncertainty."

## Where the metrics come from

The view never touches Prisma — every shape returned by the endpoints comes from `@/lib/orchestration/analytics` (`getEngagementMetrics`, `getPopularTopics`, `getUnansweredQuestions`, `getFeedbackSummary`, `getContentGaps`). For the SQL, heuristics (hedging detection for "unanswered", case-insensitive grouping for "topics", gap-ratio formula for "content gaps"), and type exports (`EngagementMetrics`, `TopicEntry`, `UnansweredEntry`, `FeedbackSummary`, `ContentGap`), see [`.context/orchestration/analytics.md`](../orchestration/analytics.md).

## Related docs

- [`.context/orchestration/analytics.md`](../orchestration/analytics.md) — analytics library (query functions, heuristics, types)
- [`.context/admin/orchestration-observability.md`](./orchestration-observability.md) — dashboard stats, trace viewers (complementary metrics)
- [`.context/admin/orchestration-costs.md`](./orchestration-costs.md) — spend/budget dashboard (same page-shell + client-island pattern)
- [`.context/api/orchestration-endpoints.md`](../api/orchestration-endpoints.md) — full HTTP reference for every admin route
- [`.context/ui/contextual-help.md`](../ui/contextual-help.md) — `<FieldHelp>` copy voice
