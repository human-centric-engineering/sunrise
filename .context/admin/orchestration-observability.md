# Observability Dashboard

Phase 7 Session 7.2 — dashboard metrics, trace viewers, and logging audit.

## Quick Reference

| Feature                  | Path                                                                    |
| ------------------------ | ----------------------------------------------------------------------- |
| Dashboard page           | `app/admin/orchestration/page.tsx`                                      |
| Stats aggregation API    | `app/api/v1/admin/orchestration/observability/dashboard-stats/route.ts` |
| Executions list API      | `app/api/v1/admin/orchestration/executions/route.ts`                    |
| Conversation GET API     | `app/api/v1/admin/orchestration/conversations/[id]/route.ts`            |
| Conversation detail page | `app/admin/orchestration/conversations/[id]/page.tsx`                   |
| Execution detail page    | `app/admin/orchestration/executions/[id]/page.tsx`                      |
| ConversationTraceViewer  | `components/admin/orchestration/conversation-trace-viewer.tsx`          |
| ExecutionDetailView      | `components/admin/orchestration/execution-detail-view.tsx`              |
| ObservabilityStatsCards  | `components/admin/orchestration/observability-stats-cards.tsx`          |
| RecentErrorsPanel        | `components/admin/orchestration/recent-errors-panel.tsx`                |
| TopCapabilitiesPanel     | `components/admin/orchestration/top-capabilities-panel.tsx`             |

## Dashboard Data Flow

The orchestration dashboard (`app/admin/orchestration/page.tsx`) is a server component that fetches data in parallel:

1. **Existing fetches**: cost summary, budget alerts, agents/workflows/conversations counts, recent activity
2. **New fetches** (Session 7.2):
   - `getDashboardStats()` → `GET /observability/dashboard-stats` — returns active conversations, today's requests, error rate, recent errors, top capabilities
   - `getModels()` → `GET /models` — for the cost trend chart tier breakdown

New dashboard sections below existing content:

- **Observability row** — 3 cards via `ObservabilityStatsCards`: Active Conversations, Today's Requests, Error Rate (24h)
- **Two-column grid** — 7-day cost trend chart (left) + top capabilities bar chart (right)
- **Recent errors** — last 5 failed executions with links

## API Endpoints

### GET /observability/dashboard-stats

Returns aggregated observability metrics. All queries run in a single `Promise.all`.

Response shape:

```typescript
{
  activeConversations: number,     // AiConversation where isActive=true, scoped to userId
  todayRequests: number,           // AiCostLog count since midnight UTC
  errorRate: number,               // failed/total executions (24h), 0 if no executions
  recentErrors: Array<{
    id: string,
    errorMessage: string | null,
    workflowId: string,
    createdAt: string,
  }>,
  topCapabilities: Array<{
    slug: string,
    count: number,
  }>,
}
```

### GET /executions (list)

Paginated list of workflow executions. Follows conversations list pattern.

Query params: `page`, `limit`, `workflowId`, `status`, `startDate`, `endDate` (via `listExecutionsQuerySchema`).

Includes `workflow: { select: { id, name } }`. Scoped to `session.user.id`.

### GET /conversations/:id (detail)

Returns a single conversation with agent info and message count. Scoped to `session.user.id` (404 for cross-user, not 403).

Includes `agent: { select: { id, name, slug } }`, `_count: { select: { messages } }`.

## Conversation Trace Viewer

Server page at `app/admin/orchestration/conversations/[id]/page.tsx` with client component `ConversationTraceViewer`.

Layout:

- **Summary bar**: 4 mini-cards — message count, total tokens, total cost, avg latency
- **Message timeline**: vertical list of message cards
  - Role badge (User/Assistant/System/Tool)
  - Content (tool messages render as `<pre>`)
  - Metadata bar: model, input/output tokens, latency, cost
  - "Raw" toggle: expands full `metadata` JSON

Token/cost/latency parsed from `AiMessage.metadata: { tokenUsage?, modelUsed?, latencyMs?, costUsd? }`.

## Execution Trace Viewer

Server page at `app/admin/orchestration/executions/[id]/page.tsx` with client component `ExecutionDetailView`.

Layout:

- **Summary section**: 5 cards — status badge, total tokens, total cost, budget bar, duration.
- **Error banner**: red alert when `execution.errorMessage` is present.
- **Input/Output**: collapsible JSON cards (the execution-level inputs / outputs, distinct from the per-step `input` field).
- **Aggregates card**: step time sum (sum of per-step `durationMs` — NOT wall-clock; parallel branches inflate it), p50 / p95 step duration, slowest step, LLM share (sum of `llmDurationMs` / step time sum), per-step-type breakdown (count · duration · tokens). True wall-clock is shown in the Duration card up in the summary grid. Hidden for traces with fewer than 2 entries.
- **Timeline strip**: Gantt-style horizontal bar per step, widths proportional to the slowest step. Slow outliers (≥ p90 in traces with ≥ 5 entries) and failed bars colour-coded; awaiting-approval bars amber-striped. Click → ring-highlights and scrolls to the matching trace row below.
- **Filter chips**: All / Failed / Slow / LLM only / Tool only / With approvals. Local state only — filter selection is not persisted to URL. Disabled chips show their (zero) count rather than vanishing.
- **Step timeline**: per-trace-entry `ExecutionTraceEntryRow` with header (status pill, label, type, **provider · model chip**, duration, **latency breakdown** "LLM xxx ms · other yyy ms", token split, cost). Expanded body shows **input + output side-by-side** and a **per-call cost sub-table** populated from `costEntries[]` grouped by `stepId`.

The aggregates card and timeline strip both use the pure helpers in `lib/orchestration/trace/aggregate.ts` (`computeTraceAggregates`, `slowOutlierThresholdMs`) so the engine-side rollup at write time and the UI-side rendering share one implementation.

**Per-step optional fields.** As of the trace-viewer work, every entry in `executionTrace` carries six optional fields the engine populates from per-step LLM telemetry:

| Field           | Source                                                                       |
| --------------- | ---------------------------------------------------------------------------- |
| `input`         | Snapshot of `step.config` at execution time                                  |
| `model`         | LLM model id (last turn for multi-turn executors)                            |
| `provider`      | Provider slug (last turn for multi-turn executors)                           |
| `inputTokens`   | Sum of input tokens across every LLM turn the step issued                    |
| `outputTokens`  | Sum of output tokens                                                         |
| `llmDurationMs` | Sum of `provider.chat()` wall-clock; `durationMs - llmDurationMs` ≈ overhead |

All optional and back-compatible with historical rows. See [`../orchestration/engine.md`](../orchestration/engine.md) for the capture mechanism (`stepTelemetry?` channel + `snapshotContext` overload).

**Per-call cost (`costEntries`).** `GET /executions/:id` joins `AiCostLog` rows by `workflowExecutionId`, filters to those with `metadata.stepId`, and returns a flat `costEntries[]` array. The view groups client-side by `stepId` and renders a per-call sub-table inside each expanded trace row. Multi-turn executors (`tool_call`, `agent_call`, `orchestrator`) naturally produce several rows per step.

**Live status polling.** The summary section (status, current step, tokens, cost, error banner) is driven by `useExecutionStatusPoller` (`lib/hooks/use-execution-status-poller.ts`), which polls `GET /executions/:id/status` every 3 seconds while the execution is in a non-terminal status. The poll uses the lightweight status endpoint (no trace, no input/output) so it stays cheap on long-running executions. Once the status flips to `completed`/`failed`/`cancelled` the hook stops polling and calls `router.refresh()` so the server-rendered trace updates with the final state. The trace itself, input/output JSON, costEntries, and budget cap come from the initial server-rendered fetch and are not polled.

## Logging Audit

All key orchestration files use structured logging:

| File                                               | Logging                                                              |
| -------------------------------------------------- | -------------------------------------------------------------------- |
| `lib/orchestration/llm/anthropic.ts`               | `logger.info('Anthropic chat request', { model, inputTokens, ... })` |
| `lib/orchestration/llm/openai-compatible.ts`       | `logger.info('OpenAI-compatible chat request', { ... })`             |
| `lib/orchestration/capabilities/dispatcher.ts`     | `logger.info('Capability dispatched', { slug, success, latencyMs })` |
| `lib/orchestration/engine/orchestration-engine.ts` | `ctx.logger.warn/error` with executionId                             |
| `lib/orchestration/chat/streaming-handler.ts`      | `logger.warn/error` for tool loop and crashes                        |

All new API routes use `getRouteLogger(request)` for request-scoped structured logging.

## Test Coverage

| Test File                                                         | Tests                                                             |
| ----------------------------------------------------------------- | ----------------------------------------------------------------- |
| `tests/integration/api/.../executions.list.test.ts`               | Auth, pagination, ownership scope                                 |
| `tests/integration/api/.../conversations.id.get.test.ts`          | Auth, detail, 404 cross-user, CUID validation                     |
| `tests/integration/api/.../observability.dashboard-stats.test.ts` | Auth, all stats, zero-division safety                             |
| `tests/integration/app/.../conversations/detail-page.test.tsx`    | Heading, breadcrumb, notFound                                     |
| `tests/integration/app/.../executions/detail-page.test.tsx`       | Heading, breadcrumb, notFound                                     |
| `tests/unit/.../observability-stats-cards.test.tsx`               | Card rendering, null safety, error rate styling                   |
| `tests/unit/.../recent-errors-panel.test.tsx`                     | Errors, empty state, links                                        |
| `tests/unit/.../top-capabilities-panel.test.tsx`                  | Ranked list, empty state, bars                                    |
| `tests/unit/.../conversation-trace-viewer.test.tsx`               | Messages, roles, metadata, raw toggle                             |
| `tests/unit/.../execution-detail-view.test.tsx`                   | Summary, trace, error banner, I/O cards                           |
| `tests/unit/.../execution-aggregates.test.tsx`                    | Aggregates card (p50/p95, slowest, LLM share)                     |
| `tests/unit/.../execution-timeline-strip.test.tsx`                | Timeline bars, slow-outlier mark, click handler                   |
| `tests/unit/.../execution-trace-filters.test.tsx`                 | Filter chips + `applyTraceFilter` pure function                   |
| `tests/unit/.../execution-trace-entry.test.tsx`                   | Per-step expansion, model chip, latency breakdown, cost sub-table |
| `tests/unit/.../trace/aggregate.test.ts`                          | Pure aggregate helpers (rollup, percentiles)                      |
| `tests/integration/orchestration/trace-capture.test.ts`           | End-to-end trace shape round-trips through schema                 |
