# Orchestration Conversations

Admin UI for browsing, inspecting, tagging, and exporting AI agent conversations and their message traces.

> Source of truth: `app/admin/orchestration/conversations/` + `components/admin/orchestration/conversation*.tsx`. Update this doc when those files change.

## Quick Reference

| What                      | Path                                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| List page                 | `app/admin/orchestration/conversations/page.tsx`                                                                                                                 |
| Detail page               | `app/admin/orchestration/conversations/[id]/page.tsx`                                                                                                            |
| List table                | `components/admin/orchestration/conversations-table.tsx`                                                                                                         |
| Trace viewer              | `components/admin/orchestration/conversation-trace-viewer.tsx`                                                                                                   |
| Tag editor                | `components/admin/orchestration/conversation-tags.tsx`                                                                                                           |
| List / read / patch / del | `app/api/v1/admin/orchestration/conversations/`                                                                                                                  |
| Messages (admin scope)    | `app/api/v1/admin/orchestration/conversations/[id]/messages/`                                                                                                    |
| Export                    | `app/api/v1/admin/orchestration/conversations/export/`                                                                                                           |
| Bulk clear                | `app/api/v1/admin/orchestration/conversations/clear/`                                                                                                            |
| Semantic search           | `app/api/v1/admin/orchestration/conversations/search/`                                                                                                           |
| Validation schemas        | `lib/validations/orchestration.ts` (`listConversationsQuerySchema`, `updateConversationSchema`, `conversationExportQuerySchema`, `clearConversationsBodySchema`) |

What admins can do from the UI:

- Browse + paginate conversations (25 per page).
- Filter by agent, active/inactive, title search, full message-content search.
- Open a conversation and read the full message trace with per-message metadata.
- Add / remove free-text tags on a conversation.
- Export the current agent-filtered view as JSON (CSV available via the endpoint).

What admins **cannot** do from the UI (API-only — no UI wiring):

- Bulk clear (`/conversations/clear`). Endpoint exists and is smoke-tested, but no UI affordance calls it.
- Filter by `tag`, `userId`, or `dateFrom` / `dateTo`. Supported by the list endpoint but not rendered in the toolbar.

## List View

Route: `/admin/orchestration/conversations`.

Initial render is a server component (`ConversationsListPage`) that fires two parallel `serverFetch` calls — the first page of conversations (`page=1`, `limit=25`) and the first 100 agents for the filter dropdown. Failures degrade to an empty list with a logged error, not a thrown 500.

Client-side state lives in `ConversationsTable`.

### Columns

| Column   | Source            | Notes                                                              |
| -------- | ----------------- | ------------------------------------------------------------------ |
| Title    | `title`           | Links to detail page. Falls back to `'Untitled'`.                  |
| Agent    | `agent.name`      | Joined via `agent: { select: { id, name, slug } }`. `—` when null. |
| Messages | `_count.messages` | Single aggregate — no per-row fetch.                               |
| Status   | `isActive`        | Badge: `Active` (default) / `Inactive` (outline).                  |
| Updated  | `updatedAt`       | Formatted `en-GB` with date + time.                                |

Rows dim (`opacity-50`) while a refetch is in flight.

### Filters and search

All filter changes re-fetch page 1 from `/api/v1/admin/orchestration/conversations`.

- **Title search** — debounced 300 ms → `?q=` (case-insensitive `contains` on `title`).
- **"Search messages" checkbox** — routes to the pgvector-backed `/conversations/search?q=…` endpoint (with the current agent filter forwarded). Placeholder flips to `"Search message content…"`. If the server responds with `meta.semanticAvailable === false` (no embedding provider configured, or the embedding call threw), the table automatically re-fetches from the list endpoint using lexical `?messageSearch=` — no UI prompt. Semantic results come back un-paginated: `totalPages` is pinned to `1` so the pager doesn't render.
- **Agent filter** — `?agentId=` (`all` omits the param). Forwarded to the semantic endpoint as well when "Search messages" is on.
- **Active filter** — `?isActive=true|false` (`all` omits the param). Not forwarded to the semantic endpoint.

No cross-user filter, date filter, or tag filter is exposed in the UI despite the endpoint accepting `userId`, `dateFrom`, `dateTo`, `tag`.

### Pagination

Server-driven via `PaginationMeta` (`parsePaginationMeta` on the response). The pager only renders when `totalPages > 1`. Prev/Next advance a single page at a time — no jump-to-page control.

### Export button

Top-right of the toolbar. Redirects the browser via `window.location.href` to `/api/v1/admin/orchestration/conversations/export?format=json`, carrying the current `agentId` filter only. Other active filters (title search, message search, active flag) are **not** forwarded to the export.

The endpoint caps at 500 conversations (`MAX_EXPORT_CONVERSATIONS`) and is rate-limited to 1 request per minute per admin IP via `adminLimiter.check('export:'+ip)`. CSV output is available by passing `?format=csv` directly to the URL but the button only issues `json`.

## Trace Viewer (detail page)

Route: `/admin/orchestration/conversations/:id`.

Server component fetches conversation + messages in parallel via `serverFetch`. A missing conversation calls `notFound()` → 404 page.

Header shows the title (or `"Untitled conversation"`), breadcrumb, agent name, creation date (localeDateString), and message count.

Below the header, an inline `ConversationTags` row lets the admin add/remove tags.

The main `ConversationTraceViewer` renders two blocks:

### Summary bar (4 cards)

Derived client-side by summing each message's metadata:

| Card         | Computation                                                                         |
| ------------ | ----------------------------------------------------------------------------------- |
| Messages     | `messages.length`                                                                   |
| Total Tokens | Σ `tokenUsage.input + tokenUsage.output` (missing values count as 0).               |
| Total Cost   | Σ `costUsd`, shown as `$0.0000` (4 dp).                                             |
| Avg Latency  | Mean `latencyMs` across messages that have it; `—` when no message reports latency. |

Metadata is parsed through `messageMetadataSchema` (`lib/validations/orchestration.ts`) — malformed metadata silently reduces to an empty object, so a broken message never crashes the viewer.

### Message timeline

One card per `AiMessage`, ordered by `createdAt asc`. Each card shows:

- **Role badge** — `User` / `Assistant` / `System` / `Tool` with matching lucide icon (`User`, `Bot`, `Settings`, `Wrench`). Unknown roles fall through to the user config.
- **Capability slug** — rendered next to the badge **only** for `role === 'tool'` messages when `capabilitySlug` is set.
- **Timestamp** — localised date+time.
- **Content** — plain `<p>` with `whitespace-pre-wrap` for non-tool roles; `<pre>` monospace block for tool messages (tool output is raw JSON/text).
- **Metadata bar** — inline chips for `modelUsed`, `tokenUsage.input` (`"N in"`), `tokenUsage.output` (`"N out"`), `latencyMs` (`"N ms"`), `costUsd` (`"$0.0000"`). Row only renders if at least one field is present.
- **Raw toggle** — only appears when `metadata` has at least one key. Expands a `<pre>` with `JSON.stringify(metadata, null, 2)`.

The viewer does **not** render tool-call spans, a collapsible tree, a parent/child linkage via `toolCallId`, or any execution-style trace visualisation. `toolCallId` is on the wire type but unused by the component.

## Tagging

### Data model

Tags are stored as `AiConversation.tags: String[]` (Postgres `text[]`, default `[]`). No separate `Tag` table, no tag catalogue, no per-user namespacing — tags are free-text strings on the conversation row. The list endpoint supports `?tag=<value>` (`has` match) for exact-string filtering, but the UI doesn't expose it.

### UI behaviour (`ConversationTags`)

- Displays each tag as a `secondary` badge with an `X` remove button.
- **Add tag** button opens an inline `Input` + `Plus` submit. Empty tags and duplicates (`tags.includes(tag)`) are silently ignored.
- Updates are **optimistic** — local state changes immediately, then `PATCH /conversations/:id` fires with the new array.
- On PATCH failure the UI reverts to `initialTags` (the value supplied at first render), **not** the previous local state — so consecutive edits before a failure can roll back multiple steps. Errors are swallowed (no toast, no logging).
- `updateConversationSchema` caps tags at 20 entries, 1–100 chars each, trimmed. Over-limit submissions fail silently from the UI's perspective.

## Operations

### Export

- Button: list toolbar. Forwards only `agentId`.
- Endpoint supports `format=json|csv`, `agentId`, `userId`, `dateFrom`, `dateTo`. Defaults to `json`.
- Hard cap: 500 conversations per export.
- Rate limit: 1/min per admin IP via `adminLimiter` keyed on `export:<ip>`.
- CSV columns: `conversation_id, conversation_title, agent_slug, user_id, message_role, message_content, created_at` (one row per message). `csvEscape` quotes values containing `, "` or newline.
- JSON payload wraps data in `{ success: true, data: [...], meta: { total } }` and serves it as a file download via `Content-Disposition: attachment`.

### Bulk clear (API only, no UI)

- `POST /conversations/clear` with `{ olderThan?, agentId? }`.
- `clearConversationsBodySchema` **requires at least one filter** — an empty body fails validation (400). This is the safety rail; there is no confirm dialog, no dry-run, and no UI affordance calling it.
- `userId` is hardcoded to `session.user.id` on the server — an admin calling clear only wipes **their own** conversations, not other users'. Cross-user bulk delete is not supported through this endpoint.
- Rate limit: `adminLimiter` per client IP.

### Semantic search (API only, no UI)

- `GET /conversations/search?q=…` embeds `q` via `embedText(q, 'query')`, runs cosine-distance search against `ai_message_embedding` (`<=>` with pgvector), and returns conversations grouped by best-matching message.
- Params: `q` (1–500 chars, required), `agentId`, `userId`, `dateFrom`, `dateTo`, `limit` (1–50, default 10), `threshold` (0–1, default 0.8 — results with distance `< threshold`).
- The list toolbar's "Search messages" checkbox does **not** call this — it calls the plain `?messageSearch=` lexical filter on the list endpoint.

## Data Sources

One row per admin endpoint backing this UI.

| Path                                                     | Method | Purpose                                                                                                                  |
| -------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------ |
| `/api/v1/admin/orchestration/conversations`              | GET    | Paginated list with filters (`agentId`, `userId`, `isActive`, `q`, `messageSearch`, `tag`, `dateFrom`, `dateTo`).        |
| `/api/v1/admin/orchestration/conversations/:id`          | GET    | Single conversation + agent + `_count.messages`. Scoped to `session.user.id` — other users return 404.                   |
| `/api/v1/admin/orchestration/conversations/:id`          | PATCH  | Update `title`, `tags`, `isActive`. Rate-limited (`adminLimiter`). Used by `ConversationTags`.                           |
| `/api/v1/admin/orchestration/conversations/:id`          | DELETE | Hard delete; messages cascade via FK. 404 for cross-user. No UI caller.                                                  |
| `/api/v1/admin/orchestration/conversations/:id/messages` | GET    | Full messages with **admin-visible metadata** (tokens, cost, latency) — consumer route strips these. Cross-user allowed. |
| `/api/v1/admin/orchestration/conversations/export`       | GET    | JSON / CSV export, capped at 500, 1/min per admin IP.                                                                    |
| `/api/v1/admin/orchestration/conversations/clear`        | POST   | Bulk delete **the caller's own** conversations; empty body rejected.                                                     |
| `/api/v1/admin/orchestration/conversations/search`       | GET    | pgvector semantic search across message embeddings. Not wired into the UI.                                               |

Ownership / scope quirks worth noting:

- List (`GET /conversations`) is **not** userId-scoped by default — it returns rows for every user unless `?userId=` is passed. Useful for admin audit.
- Detail (`GET /conversations/:id`), PATCH, and DELETE **are** scoped to `session.user.id` and return 404 (never 403) for another user's conversation. The detail page therefore fails with `notFound()` when an admin opens a link to someone else's conversation.
- Messages (`GET /conversations/:id/messages`) is **not** userId-scoped — cross-user messages are visible, which is what makes the detail page work for admin audit of other users' conversations is **not** possible today (the parent detail fetch 404s first). Keep this asymmetry in mind when changing either route.

## Related Docs

- `.context/orchestration/chat.md` — streaming chat handler that writes the `AiMessage` rows this UI visualises.
- `.context/admin/orchestration-observability.md` — sibling trace viewer for executions; summary-bar pattern is shared.
- `.context/orchestration/admin-api.md` — full admin API surface.
- `.context/api/orchestration-endpoints.md` — HTTP reference for every orchestration route.
