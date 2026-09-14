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
- **Metadata bar** — inline chips for `modelId` (top-level column, not nested in metadata), `providerSlug`, `tokenUsage.input` (`"N in"`), `tokenUsage.output` (`"N out"`), `latencyMs` (`"N ms"`), `costUsd` (`"$0.0000"`). Row only renders if at least one field is present.
- **Provenance pin row** — small `outline` badges showing `agent <id-prefix>` and `workflow exec <id-prefix> @ <version-prefix>` when those scalars are populated on the message row. Mirrors the `SupervisorVerdictBadge` styling in `ExecutionDetailView` so the execution page and the conversation page share visual vocabulary. Omitted when no version pins are set (direct chat with the live agent).
- **Raw toggle** — only appears when `metadata` has at least one key. Expands a `<pre>` with `JSON.stringify(metadata, null, 2)`.
- **Inline tool-call trace** — when an assistant message carries `provenance.capabilityCalls` (always-on for capability-using assistant turns; not gated by `includeTrace`), `<MessageTrace>` (`components/admin/orchestration/chat/message-trace.tsx`) renders a collapsible strip with one card per dispatched capability: slug, args JSON, latency, success state, optional cost, and a result preview. Pre-feature conversations and capability-free turns leave `provenance` null and the strip is absent. See `.context/orchestration/chat.md#inline-trace-annotations-admin-only` for the full wire contract.

`toolCallId` is on the wire type but unused by the component — the tool-call linkage is reconstructed from the denormalised `capabilityCalls[]` array on the assistant turn rather than from cross-message parent/child references.

### Download provenance bundle

Above the timeline, the viewer renders a `Download provenance` button group when a `conversationId` prop is supplied (always set on the admin detail route; absent only in preview / embedded contexts):

- **JSON** — opens `/api/v1/admin/orchestration/conversations/[id]/provenance` in a new tab. Returns the typed `MessageProvenance` bundle per message + the five scalar version pins + conversation-level metadata. Suitable for programmatic consumption by an external audit pipeline.
- **Markdown** — opens `/api/v1/admin/orchestration/conversations/[id]/provenance.md`. Returns the deterministic Markdown rendering as a downloadable attachment (`text/markdown; charset=utf-8`, `Cache-Control: no-store`). The renderer ([`lib/orchestration/trace/render-conversation-markdown.ts`](../../lib/orchestration/trace/render-conversation-markdown.ts)) is deterministic — same conversation produces byte-identical output modulo the footer timestamp.
- **PDF** — reserved. The renderer emits HTML-ready Markdown so the future Gotenberg adapter is a thin downstream wrapper, but the route is not built. No PDF button renders today.

A `FieldHelp` popover next to the group explains what the bundle contains: agent / workflow / model versions, KB chunks cited (with content hash at message time), capability calls, and workflow step sources.

**Audit-of-audits.** Every successful download writes an `AiAdminAuditLog` entry with `action: 'conversation.provenance_export'`, the admin's user id, the conversation id, the format (`json` / `markdown`), the message count, and the client IP. Compliance can query "who exported this conversation's audit trail, when, in which format" from a single SQL on `ai_admin_audit_log`. Auth failures and cross-user 404s do not generate an entry.

**Persisted args are post-redaction.** The `capabilityCalls[].arguments` and `resultPreview` fields in the bundle reflect each capability's `redactProvenance()` output, not what the LLM actually saw. Auth-style headers are masked, free-text bodies and file bytes are replaced with sentinels, and PII-handling capabilities (`call_external_api`, `escalate_to_human`, `run_workflow`, `read_user_memory`, `write_user_memory`, `upload_to_storage`) ship explicit redactors. See [`.context/security/pii-redaction.md`](../security/pii-redaction.md).

## Tagging

### Data model

Tags are stored as `AiConversation.tags: String[]` (Postgres `text[]`, default `[]`). No separate `Tag` table, no tag catalogue, no per-user namespacing — tags are free-text strings on the conversation row. The list endpoint supports `?tag=<value>` (`has` match) for exact-string filtering, but the UI doesn't expose it.

### UI behaviour (`ConversationTags`)

- Displays each tag as a `secondary` badge with an `X` remove button.
- **Add tag** button opens an inline `Input` + `Plus` submit. Empty tags and duplicates (`tags.includes(tag)`) are silently ignored.
- Updates are **optimistic** — local state changes immediately, then `PATCH /conversations/:id` fires with the new array.
- On PATCH failure the UI reverts to `committedTags` (the last server-confirmed state), not `initialTags`. Each successful save updates `committedTags`, so a failure only rolls back the failing change, not prior successful edits. An inline error message is displayed.
- `updateConversationSchema` caps tags at 20 entries, 1–100 chars each, trimmed. Over-limit submissions fail silently from the UI's perspective.

## Operations

### Export

- Button: list toolbar. Forwards all active filters (`agentId`, `isActive`, title/message search).
- Endpoint supports `format=json|csv`, `agentId`, `isActive`, `q`, `messageSearch`, `tag`, `dateFrom`, `dateTo`. Defaults to `json`.
- Hard cap: 500 conversations per export, 500 messages per conversation.
- Rate limit: 1/min per admin IP via `adminLimiter` keyed on `export:<ip>`.
- CSV columns: `conversation_id, conversation_title, agent_slug, user_id, message_role, message_content, created_at` (one row per message). `csvEscape` quotes values containing `, "` or newline.
- JSON payload wraps data in `{ success: true, data: [...], meta: { total, totalMatching, capped } }` and serves it as a file download via `Content-Disposition: attachment`. `capped: true` indicates the 500-conversation cap was hit; `totalMatching` shows the untruncated count.

### Bulk clear (API only, no UI)

- `POST /conversations/clear` with `{ olderThan?, agentId?, userId?, allUsers? }`.
- `clearConversationsBodySchema` **requires at least one of `olderThan` or `agentId`** — an empty body or `allUsers: true` alone fails validation (400). This is the safety rail; there is no confirm dialog, no dry-run, and no UI affordance calling it.
- Scope:
  - default → caller's own conversations (`session.user.id`).
  - `userId: '<cuid>'` → that specific user's conversations.
  - `allUsers: true` → across all users (still narrowed by `olderThan` / `agentId`). Mutually exclusive with `userId`.
- All bulk clear operations (including self-scoped) emit an `AiAdminAuditLog` entry (`conversation.bulk_clear`) with scope, target, filters, and `deletedCount`.
- Rate limit: `adminLimiter` per client IP.

### Semantic search

- `GET /conversations/search?q=…` embeds `q` via `embedText(q, 'query')`, runs cosine-distance search against `ai_message_embedding` (`<=>` with pgvector), and returns conversations grouped by best-matching message. Same visibility as the list: the caller's own conversations, actively-shared ones, and system-owned inbound threads where the authorization policy permits an unattributed read. The predicate is hand-written SQL rather than `conversationVisibilityWhere` — a pgvector distance query is not expressible through Prisma's query builder — so the two are pinned against each other in `policy-narrowing.test.ts` — including the expiry boundary, and including a positive assertion that the ownerless arm is present on a default install, without which deleting it would leave every test green. Every match the caller doesn't own is audit-logged under the basis that admitted it.
- Params: `q` (1–500 chars, required), `agentId`, `isActive`, `dateFrom`, `dateTo`, `limit` (1–50, default 10), `threshold` (0–1, default 0.8 — results with distance `< threshold`).
- The list toolbar's "Search messages" checkbox calls this endpoint first, forwarding `agentId` and `isActive` filters. If the server signals `semanticAvailable: false` (no embedding provider configured or embedding returned non-finite values), the table falls back to lexical `?messageSearch=` on the list endpoint.
- Similarity scores in the response are clamped to `[0, 1]` (pgvector cosine distance can exceed 1 for dissimilar vectors).

## Data Sources

One row per admin endpoint backing this UI.

| Path                                                     | Method | Purpose                                                                                                                                           |
| -------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/api/v1/admin/orchestration/conversations`              | GET    | Paginated list: caller's own + actively-shared + system-owned. Filters: `agentId`, `isActive`, `q`, `messageSearch`, `tag`, `dateFrom`, `dateTo`. |
| `/api/v1/admin/orchestration/conversations/:id`          | GET    | Single conversation + agent + `_count.messages`. Gated by `adminCanViewConversation` — another admin's own returns 404.                           |
| `/api/v1/admin/orchestration/conversations/:id`          | PATCH  | Update `title`, `tags`, `isActive`. Owner or system-owned only. Rate-limited (`adminLimiter`). Used by `ConversationTags`.                        |
| `/api/v1/admin/orchestration/conversations/:id`          | DELETE | Hard delete; messages cascade via FK. Owner or system-owned only; 404 otherwise. No UI caller.                                                    |
| `/api/v1/admin/orchestration/conversations/:id/messages` | GET    | Full messages with **admin-visible metadata** (tokens, cost, latency) — consumer route strips these. Cross-user allowed.                          |
| `/api/v1/admin/orchestration/conversations/export`       | GET    | JSON / CSV export, capped at 500, 1/min per admin IP.                                                                                             |
| `/api/v1/admin/orchestration/conversations/clear`        | POST   | Bulk delete by filter; default scope = caller, opt-in `userId` or `allUsers: true` for cross-user. Empty body rejected.                           |
| `/api/v1/admin/orchestration/conversations/search`       | GET    | pgvector semantic search across message embeddings, same visibility as the list. Wired into the UI via "Search messages".                         |

Ownership / scope notes:

- Visibility has **three bases** (`lib/orchestration/access/conversation-access.ts`): `'owner'`, `'shared'` (the owner created an active `AiConversationShare`), and `'system'` — nobody owns the row, and the authorization policy permits this caller an unattributed read. Only that third basis asks the policy; the other two are facts about one caller and one row. Inbound threads are system-owned since [#502](https://github.com/human-centric-engineering/sunrise/issues/502): the messages belong to a third party with no account here, so attributing them to the operator who configured the channel made them cascade-deletable by that operator's erasure and disclosable in their subject-access export.
- List, detail and search apply all three. **Export applies only `'owner'`** — bulk-downloading hundreds of third parties' message bodies under one audit row is a different act from reading one thread, and the per-conversation routes cover the audit-export case with per-access logging.
- PATCH and DELETE accept `'owner'` and `'system'`, never `'shared'` — a share grants view consent, not write-or-destroy consent. `'system'` is included because an inbound thread has no owner, and deleting it is the only per-thread erasure route open to the person who sent the messages (`eraseUser()` cannot reach someone with no account).

- **A narrowing policy closes that route, and this is the one place it costs more than visibility.** Both verbs gate on `adminCanViewConversation`, so a fork whose `canRead` refuses unattributed reads gets a 404 on `DELETE /conversations/:id` for every inbound thread — and the Art. 17 request from the member of the public who sent the messages cannot then be honoured per-thread by anybody. `POST /conversations/clear` with `allUsers` still reaches those rows, because it consults no policy at all, but that is a blunt instrument and an incoherent posture rather than an answer. **A fork narrowing this arm must keep some principal its own policy admits for ownerless threads**, or it has no erasure path for a data subject with no account. Tracked as [#776](https://github.com/human-centric-engineering/sunrise/issues/776), with four costed options.
- Anything other than `'owner'` writes an `AiAdminAuditLog` row carrying `metadata.accessBasis`; self-access is deliberately unlogged. Any `userId` query parameter is silently ignored. This covers **mutations as well as reads** — `conversation.metadata_viewed`, `conversation.updated` (with `metadata.fields` naming what changed, not the values, so a renamed `title` doesn't put message content in the log), and `conversation.deleted`. A compliance query for "which conversations that weren't theirs did admin X touch this month?" would silently miss every rename and archive if PATCH were exempt.
- Detail (`GET /conversations/:id`), PATCH, and DELETE return 404 (never 403) when the basis doesn't permit the action.
- Messages (`GET /conversations/:id/messages`) is **not** userId-scoped — any admin can fetch any conversation's messages via direct API call. This is intentional for admin audit use cases (e.g. scripts, dashboards). The detail page blocks cross-user viewing at the page level (the parent conversation fetch 404s first, calling `notFound()` before messages render). Keep this asymmetry in mind when changing either route.

## Related Docs

- `.context/orchestration/chat.md` — streaming chat handler that writes the `AiMessage` rows this UI visualises.
- `.context/admin/orchestration-observability.md` — sibling trace viewer for executions; summary-bar pattern is shared.
- `.context/orchestration/admin-api.md` — full admin API surface.
- `.context/api/orchestration-endpoints.md` — HTTP reference for every orchestration route.
