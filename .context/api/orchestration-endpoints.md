# Agent Orchestration API Endpoints

Consumer-focused HTTP reference for every admin orchestration endpoint, consolidated across Phase 3 sessions 3.1 – 3.4. For architecture and design rationale see the per-domain docs under `.context/orchestration/`.

**Base path:** `/api/v1/admin/orchestration`
**Authentication:** Every endpoint requires a session with the `ADMIN` role (`withAdminAuth` in `lib/auth/guards.ts`). Non-admins get `403`, unauthenticated callers get `401`.
**Rate limiting:** Every mutating handler (`POST`, `PATCH`, `DELETE`) is gated by `adminLimiter` (30 req/min per IP, see `lib/security/rate-limit.ts`). `GET` routes are unlimited.
**Response envelope:**

```jsonc
// Success
{ "success": true, "data": <payload>, "meta": { /* optional pagination */ } }

// Error
{ "success": false, "error": { "code": "ERROR_CODE", "message": "...", "details": { /* optional */ } } }
```

Validation schemas for every request body / query live in `lib/validations/orchestration.ts`. Typed errors (`NotFoundError`, `ValidationError`, `ConflictError`) funnel through `handleAPIError`.

## Quick reference

| Endpoint                           | Methods            | Purpose                                              | Session |
| ---------------------------------- | ------------------ | ---------------------------------------------------- | ------- |
| `/agents`                          | GET, POST          | List / create agents                                 | 3.1     |
| `/agents/:id`                      | GET, PATCH, DELETE | Read / update / soft-delete                          | 3.1     |
| `/agents/:id/capabilities`         | POST               | Attach capability                                    | 3.1     |
| `/agents/:id/capabilities/:capId`  | PATCH, DELETE      | Update / detach pivot row                            | 3.1     |
| `/agents/:id/instructions-history` | GET                | Read `systemInstructions` audit trail                | 3.1     |
| `/agents/:id/instructions-revert`  | POST               | Revert to a previous `systemInstructions`            | 3.1     |
| `/agents/export`                   | POST               | Export selected agents as a bundle                   | 3.1     |
| `/agents/import`                   | POST               | Import an agent bundle                               | 3.1     |
| `/capabilities`                    | GET, POST          | List / create capabilities                           | 3.1     |
| `/capabilities/:id`                | GET, PATCH, DELETE | Read / update / soft-delete                          | 3.1     |
| `/providers`                       | GET, POST          | List / create LLM provider configs                   | 3.2     |
| `/providers/:id`                   | GET, PATCH, DELETE | Read / update / soft-delete                          | 3.2     |
| `/providers/:id/test`              | POST               | Live connection test                                 | 3.2     |
| `/providers/:id/models`            | GET                | Provider-reported models                             | 3.2     |
| `/models`                          | GET                | Aggregated model registry                            | 3.2     |
| `/workflows`                       | GET, POST          | List / create workflows                              | 3.2     |
| `/workflows/:id`                   | GET, PATCH, DELETE | Read / update / soft-delete                          | 3.2     |
| `/workflows/:id/validate`          | POST               | DAG validation                                       | 3.2     |
| `/workflows/:id/execute`           | POST               | Run workflow _(501 stub — Session 5.2)_              | 3.2     |
| `/executions/:id`                  | GET                | Read execution _(501 stub — Session 5.2)_            | 3.2     |
| `/executions/:id/approve`          | POST               | Approve paused execution _(501 stub — Session 5.2)_  | 3.2     |
| `/chat/stream`                     | POST               | Streaming chat turn (SSE)                            | 3.3     |
| `/knowledge/search`                | POST               | Hybrid vector + keyword search                       | 3.3     |
| `/knowledge/patterns/:number`      | GET                | Fetch all chunks for a single design pattern         | 3.3     |
| `/knowledge/documents`             | GET, POST          | List / upload document (multipart)                   | 3.3     |
| `/knowledge/documents/:id`         | GET, DELETE        | Read / delete document                               | 3.3     |
| `/knowledge/documents/:id/rechunk` | POST               | Rechunk + re-embed                                   | 3.3     |
| `/knowledge/seed`                  | POST               | Seed chunks (no embeddings) for design patterns      | 3.3     |
| `/knowledge/embed`                 | POST               | Generate embeddings for unembedded chunks            | 3.3     |
| `/knowledge/embedding-status`      | GET                | Embedding coverage stats + provider availability     | 3.3     |
| `/embedding-models`                | GET                | Static registry of embedding models (filterable)     | 7.0     |
| `/conversations`                   | GET                | List caller's conversations                          | 3.3     |
| `/conversations/:id`               | DELETE             | Delete one of the caller's conversations             | 3.3     |
| `/conversations/:id/messages`      | GET                | Read messages of one conversation                    | 3.3     |
| `/conversations/clear`             | POST               | Bulk-delete by filter (at least one filter required) | 3.3     |
| `/costs`                           | GET                | Breakdown by day / agent / model                     | 3.4     |
| `/costs/summary`                   | GET                | Today / week / month + per-agent + trend             | 3.4     |
| `/costs/alerts`                    | GET                | Agents ≥ 80% of their budget                         | 3.4     |
| `/settings`                        | GET, PATCH         | Task-type defaults + global monthly budget cap       | 4.4     |
| `/agents/:id/budget`               | GET                | Read-only budget status                              | 3.4     |
| `/evaluations`                     | GET, POST          | List caller's sessions / create                      | 3.4     |
| `/evaluations/:id`                 | GET, PATCH         | Read / update                                        | 3.4     |
| `/evaluations/:id/logs`            | GET                | Read log events                                      | 3.4     |
| `/evaluations/:id/complete`        | POST               | Run AI analysis and flip to `completed`              | 3.4     |

42 endpoints. For architecture detail see `.context/orchestration/admin-api.md`.

---

## Ownership scoping

These resource families are scoped to `session.user.id`. Cross-user access returns **`404` (never `403`)** to avoid confirming existence:

- `/conversations/*`
- `/evaluations/*`

The rest are admin-global: every admin sees the same data.

---

## Agents

### `GET /agents`

List agents (paginated). Query: `page`, `limit`, `isActive`, `provider`, `q`. `q` is a case-insensitive `OR` across `name` / `slug` / `description`.

### `POST /agents`

Create agent. Body validated by `createAgentSchema`. Slug collision → `409 CONFLICT`.

### `GET / PATCH / DELETE /agents/:id`

Read / update / soft-delete. `DELETE` sets `isActive: false` (hard delete would violate FK relationships to audit tables).

`PATCH` updates each optional field conditionally. When `systemInstructions` changes, the previous value is pushed onto `systemInstructionsHistory` as `{ instructions, changedAt, changedBy }` for audit.

### `POST /agents/:id/capabilities`

Attach a capability. Body: `{ capabilityId, isEnabled?, customConfig?, customRateLimit? }`. Already-attached → `409 CONFLICT`.

### `PATCH / DELETE /agents/:id/capabilities/:capId`

`capId` is the `AiCapability.id` (not the pivot row id). Missing link → `404`.

### `GET /agents/:id/instructions-history`

Returns the full audit array. Malformed rows are logged server-side and skipped in the response.

### `POST /agents/:id/instructions-revert`

Body: `{ index: number }` — revert to a previous history entry. The current value is pushed onto history before the overwrite, so the revert itself is also recoverable.

### `POST /agents/export` / `POST /agents/import`

Versioned bundle format. Import runs in a single transaction with `conflictMode: 'skip' | 'overwrite'`. Capabilities are embedded by slug for cross-environment portability.

---

## Capabilities

### `GET /capabilities`

List. Query: `page`, `limit`, `isActive`, `q`.

### `POST /capabilities`

Create. Body validated by `createCapabilitySchema` — `functionDefinition` must be a JSON Schema compatible with the LLM tool-use format.

### `GET / PATCH / DELETE /capabilities/:id`

Standard CRUD. `DELETE` is a soft delete. Dispatcher cache is cleared on every mutation.

---

## Providers

### `GET /providers`

Returns each `AiProviderConfig` hydrated with `apiKeyPresent: boolean`. **The raw env var value is never returned, logged, or written to any response envelope.**

### `POST /providers`

Create. Body validated by `providerConfigSchema` — which runs `checkSafeProviderUrl` via a Zod `.superRefine()` to block SSRF targets (cloud metadata IPs, RFC1918, CGNAT, link-local, IPv6 unique-local, loopback unless `isLocal: true`, non-http(s) schemes).

### `GET / PATCH / DELETE /providers/:id`

Standard CRUD. `PATCH` merges the update and re-runs the SSRF guard in `buildProviderFromConfig` as defense-in-depth.

### `POST /providers/:id/test`

Runs a live `testConnection()`. The response **strips raw SDK / fetch error messages** — success returns the reported models; failure returns a generic `connection_failed` error. The real error is logged server-side only to prevent using the endpoint as a blind-SSRF port scanner.

### `GET /providers/:id/models`

Asks the provider directly. Same error-sanitization guarantee as `/test`.

### `GET /models`

Aggregated registry across all configured providers. Query: `?refresh=true` to bypass the in-process cache.

---

## Workflows

### `GET /workflows` / `POST /workflows`

CRUD. The body is a `WorkflowDefinition` — a DAG of step nodes. Stored as `Json`.

### `GET / PATCH / DELETE /workflows/:id`

Standard CRUD.

### `POST /workflows/:id/validate`

Runs the pure-logic DAG validator from `lib/orchestration/workflows/validator.ts`. Checks duplicate ids, entry existence, unknown targets, reachability (BFS), cycle detection (DFS gray/black), and per-type config requirements. Returns `{ valid: true }` or `{ valid: false, errors: [{ code, message, path }] }`. Error codes are stable — render by `code`, never `message`.

### `POST /workflows/:id/execute`, `GET /executions/:id`, `POST /executions/:id/approve`

**501 stubs** until Session 5.2 ships the execution engine. Full route handlers exist — they validate inputs, resolve the workflow / execution, and return `501 NOT_IMPLEMENTED`. The contract is locked for Phase 4 UI work.

---

## Chat (streaming)

### `POST /chat/stream`

Streams a single chat turn as **Server-Sent Events** (`text/event-stream`). Request body is validated by `chatStreamRequestSchema`:

```jsonc
{
  "agentId": "<cuid>",
  "message": "User message text",
  "conversationId": "<cuid>", // optional — creates new conversation when absent
  "metadata": {
    /* optional */
  },
}
```

Response headers:

```
Content-Type: text/event-stream
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

#### Event contract

Each event is framed as:

```
event: <type>
data: <json>

```

`ChatEvent` union (from `types/orchestration.ts:191-197`):

| `type`              | `data` shape                                                            | Meaning                                                              |
| ------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `start`             | `{ conversationId, messageId }`                                         | First event — conversation is ready and the assistant turn has begun |
| `content`           | `{ delta: string }`                                                     | Incremental assistant text                                           |
| `status`            | `{ phase: 'thinking' \| 'calling_tool' \| 'writing'; detail?: string }` | Human-readable progress indicator                                    |
| `capability_result` | `{ name, input, output, durationMs }`                                   | A tool call completed — mid-stream                                   |
| `warning`           | `{ code, message }`                                                     | Non-terminal warning (e.g. budget at 80%) — stream continues         |
| `done`              | `{ usage: { input, output }, finishReason }`                            | Terminal success frame                                               |
| `error`             | `{ code, message }`                                                     | Terminal error frame                                                 |

Plus periodic keepalive comment frames (`: keepalive\n\n`) every 15 000 ms — comments are ignored by `EventSource` and standard SSE clients.

#### Error sanitization

The chat handler's catch-all emits `{ type: 'error', code: 'internal_error', message: 'An unexpected error occurred' }`. **Raw `err.message` is never forwarded.** Detailed errors are logged server-side via `logger.error`. The SSE bridge layer (`lib/api/sse.ts`) sanitizes again as defense-in-depth: if the source iterable throws, the bridge emits `{ code: 'stream_error', message: 'Stream terminated unexpectedly' }` instead of the raw error.

For the richer error taxonomy (`agent_not_found`, `conversation_not_found`, `budget_exceeded`, `tool_loop_cap`), the handler yields a typed `error` event rather than throwing — those pass through verbatim because they are data, not exceptions.

#### Reconnection

**There is no `Last-Event-ID` support.** If the connection drops, clients re-`POST` to start a new stream. The `conversationId` in the `start` frame is stable, so reconnecting against the same conversation is well-defined.

#### Cancellation

The bridge honours `AbortSignal` — clients that close the `ReadableStream` trigger cancellation of the upstream iterable and stop the keepalive timer. `fetch` + `AbortController` works as expected.

#### curl

```bash
curl -N -X POST /api/v1/admin/orchestration/chat/stream \
  -H 'Content-Type: application/json' \
  -d '{"agentId":"<cuid>","message":"Hello"}'
```

`-N` disables buffering so frames arrive live.

#### JavaScript client (`ReadableStream`)

```ts
const res = await fetch('/api/v1/admin/orchestration/chat/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agentId, message }),
  signal: controller.signal,
});

const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });

  // Split on `\n\n` — one event per frame.
  let idx: number;
  while ((idx = buffer.indexOf('\n\n')) !== -1) {
    const raw = buffer.slice(0, idx);
    buffer = buffer.slice(idx + 2);
    if (raw.startsWith(': ')) continue; // keepalive comment

    const typeLine = raw.match(/^event: (.+)$/m);
    const dataLine = raw.match(/^data: (.+)$/m);
    if (!typeLine || !dataLine) continue;

    const type = typeLine[1];
    const data = JSON.parse(dataLine[1]);
    handleEvent(type, data);
  }
}
```

`EventSource` is not usable here because `EventSource` cannot send a `POST` body.

---

## Knowledge Base

### `POST /knowledge/search`

Hybrid vector + keyword search via pgvector. Body: `{ query: string, filters?: { documentId?, chunkType? }, limit?, threshold? }` (`knowledgeSearchSchema`). **POST, not GET** — the filter payload can contain arbitrary text and we avoid query bodies in URL logs.

### `GET /knowledge/patterns/:number`

Returns every chunk tagged with the given design pattern number, in source order. `404` when no chunks exist.

### `GET /knowledge/documents`

Paginated document list. Query: `page`, `limit`, `status`, `q` (`listDocumentsQuerySchema`).

### `POST /knowledge/documents`

**Multipart upload.** Critical contract:

| Field        | Value                                                   |
| ------------ | ------------------------------------------------------- |
| Content-Type | `multipart/form-data`                                   |
| Form field   | `file`                                                  |
| Max size     | **10 MB** (`MAX_UPLOAD_BYTES` in the route)             |
| Extensions   | **`.md`, `.markdown`, `.txt` only** (case-insensitive)  |
| MIME type    | Advisory only — the extension is the load-bearing check |

PDF and HTML are **future work** — they'd need `pdf-parse` / `sanitize-html` and new chunker branches, and adding parsers without updating the extension whitelist leaves dormant code paths. Do not `POST` with `application/json`; the route only accepts multipart.

Returns `201` with the created `AiKnowledgeDocument`. Files over 10 MB → `413 FILE_TOO_LARGE`. Disallowed extension → `400 INVALID_FILE_TYPE`.

### `GET / DELETE /knowledge/documents/:id`

Read / delete. Chunks cascade via the FK relation.

### `POST /knowledge/documents/:id/rechunk`

Re-runs the chunker + embedder. Blocked with `409 CONFLICT` when the document is already in `status: 'processing'` to prevent races.

### `POST /knowledge/seed`

**Phase 1** of the two-phase seeder. Inserts all chunks from the canonical `chunks.json` with `embedding = null` and sets the document status to `ready`. The Learning Patterns UI works immediately because it reads chunks directly — no embeddings needed. Returns `{ seeded: true }`. Idempotent: skips if the document already exists. If a previous attempt left a `failed` record, it is cleaned up and re-seeded. Safe to call on every deploy.

Knowledge documents are **global, not per-user**. `uploadedBy` is recorded for audit but is not a scope boundary.

### `POST /knowledge/embed`

**Phase 2** of the two-phase seeder. Finds all chunks where `embedding IS NULL`, batches them through the configured embedding provider, and writes vectors back. Returns `{ processed, total, alreadyEmbedded }`. Can be called repeatedly — only processes chunks that still need embeddings. Requires an active embedding provider (OpenAI API key or local provider like Ollama).

### `GET /knowledge/embedding-status`

Lightweight status endpoint returning `{ total, embedded, pending, hasActiveProvider }`. Used by the Knowledge Base, Advisor, and Quiz UI to show an embedding coverage banner when search is partially available.

---

## Embedding Models

### `GET /embedding-models`

Returns a curated, static list of embedding models from the registry at `lib/orchestration/llm/embedding-models.ts`. No database queries — purely informational.

**Query params (all optional boolean):**

| Param                  | Effect                                                |
| ---------------------- | ----------------------------------------------------- |
| `schemaCompatibleOnly` | Only models that can output 1536-dim vectors          |
| `hasFreeTier`          | Only models with a free tier                          |
| `local`                | `true` = local only, `false` = cloud only, omit = all |

**Response:** `{ success: true, data: EmbeddingModelInfo[] }` — each entry has `id`, `name`, `provider`, `model`, `dimensions`, `schemaCompatible`, `costPerMillionTokens`, `hasFreeTier`, `local`, `quality`, `strengths`, `setup`.

Used by the "Compare embedding providers" modal on the Knowledge Base page.

---

## Conversations

**All conversation endpoints are scoped to `session.user.id`. Cross-user → 404.**

### `GET /conversations`

Paginated list of the caller's conversations. Query: `page`, `limit`, `agentId`, `isActive`, `q` (`listConversationsQuerySchema`).

### `DELETE /conversations/:id`

Ownership-checked by `findFirst({ where: { id, userId: session.user.id } })`. Missing OR cross-user → `404`. Messages cascade.

### `GET /conversations/:id/messages`

Paginated. Same ownership check.

### `POST /conversations/clear`

Bulk delete by filter. Body validated by `clearConversationsBodySchema`:

```jsonc
{ "olderThan": "2025-01-01T00:00:00Z" }    // or
{ "agentId": "<cuid>" }                     // or both
```

**At least one of `olderThan` or `agentId` is required** — a Zod `.refine()` rejects empty bodies. This is deliberate: an empty-body "delete everything" call is a common tooling mistake; the schema makes it impossible. The `WHERE` clause is hardcoded to `{ userId: session.user.id, ...filters }` — `userId` is never an input. Cross-user bulk delete is impossible by construction.

Returns `{ deletedCount }`.

---

## Costs

**Admin-global — not scoped to the caller.** `AiCostLog` has no user relation.

### `GET /costs`

Breakdown over a date range. Query (`costBreakdownQuerySchema`):

| Param      | Type                    | Required | Notes                    |
| ---------- | ----------------------- | -------- | ------------------------ |
| `agentId`  | CUID                    | no       | Restrict to one agent    |
| `dateFrom` | ISO date                | yes      | Inclusive, UTC midnight  |
| `dateTo`   | ISO date                | yes      | Inclusive, whole UTC day |
| `groupBy`  | `day \| agent \| model` | yes      |                          |

- `dateTo < dateFrom` → `400`
- Span > **366 days** → `400`

Response: `{ groupBy, rows: [{ key, label?, totalCostUsd, inputTokens, outputTokens, count }], totals: { totalCostUsd, inputTokens, outputTokens, count } }`.

### `GET /costs/summary`

Dashboard summary. Returns `{ totals: { today, week, month }, byAgent: [...], byModel: [...], trend: [...30 UTC days], localSavings }`. Per-agent rows include `utilisation = monthSpend / monthlyBudgetUsd` (null when no budget is set).

`localSavings` is `{ usd, methodology, sampleSize, dateFrom, dateTo } | null`. `methodology` is currently always `tier_fallback` (the only reachable mode — local rows have local model ids, so there is never a direct hosted equivalent). The field is kept as a union to allow additional modes without a response-shape break. The whole value is `null` when `calculateLocalSavings()` errored — the rest of the summary still renders. See [`../admin/orchestration-costs.md` § Local savings methodology](../admin/orchestration-costs.md#local-savings-methodology) for the algorithm.

### `GET /costs/alerts`

Returns every agent with a `monthlyBudgetUsd` at or above 80% utilisation. Severity:

| Utilisation | Severity   |
| ----------- | ---------- |
| `< 0.8`     | _omitted_  |
| `0.8..<1.0` | `warning`  |
| `>= 1.0`    | `critical` |

Agents without a budget, or with `monthlyBudgetUsd <= 0`, are filtered out.

### `GET /agents/:id/budget`

Read-only budget status for a single agent: `{ withinBudget, spent, limit, remaining }`. Missing agent → `404`. Malformed id → `400`.

**There is no `PATCH /agents/:id/budget`.** Budget mutations go through `PATCH /agents/:id` via `updateAgentSchema.monthlyBudgetUsd`. A second mutation path would fork the audit trail.

### `GET /settings` / `PATCH /settings`

Singleton orchestration settings (`slug: 'global'`). Lazily upserted on first read. Admin-only, PATCH is rate-limited.

Body for PATCH (`updateOrchestrationSettingsSchema`):

```jsonc
{
  "defaultModels": {
    "routing": "claude-haiku-4-5",
    "chat": "claude-sonnet-4-6",
    "reasoning": "claude-opus-4-6",
    "embeddings": "claude-haiku-4-5",
  },
  "globalMonthlyBudgetUsd": 500,
}
```

At least one of the two top-level fields must be present. Every model id is validated against the in-memory registry — unknown ids return `400`. `globalMonthlyBudgetUsd` must be `null`, `0`, or a positive number ≤ 1,000,000.

See [`../orchestration/admin-api.md` § Orchestration settings](../orchestration/admin-api.md#orchestration-settings-singleton) for enforcement semantics and [`../admin/orchestration-costs.md`](../admin/orchestration-costs.md) for the UI.

---

## Evaluations

**Scoped to `session.user.id`. Cross-user → 404.**

### `GET /evaluations`

Paginated list. Query (`listEvaluationsQuerySchema`): `page`, `limit`, `agentId`, `status` (`draft | in_progress | completed | archived`), `q` (title contains, case-insensitive).

### `POST /evaluations`

Create. Body (`createEvaluationSchema`):

```jsonc
{
  "agentId": "<cuid>",
  "title": "Support bot tone review",
  "description": "Sample of Q1 conversations",
  "metadata": { "sampleSize": 50 },
}
```

Returns `201` with the session in `status: 'draft'`. Agents are shared admin-wide, so any admin can create a session against any agent.

### `GET / PATCH /evaluations/:id`

Ownership-checked. Cross-user → `404`.

`PATCH` (`updateEvaluationSchema`) allows updating `title`, `description`, `status`, `metadata`. **`status: 'completed'` is explicitly rejected by the Zod schema** — completion must go through `/complete` for atomicity with the AI analysis. Empty update bodies are rejected by a `.refine()`.

### `GET /evaluations/:id/logs`

Cursor pagination. Query (`evaluationLogsQuerySchema`): `limit` (1..500, default 100), `before` (a positive integer `sequenceNumber` — rows with strictly smaller sequence numbers are returned). Ordered by `sequenceNumber` ascending. Ownership on the parent session; cross-user → `404`.

### `POST /evaluations/:id/complete`

**Synchronous POST**, not SSE. Runs an AI analysis of the session logs, updates the session to `completed`, and logs a cost row with `operation: 'evaluation'`.

- Logs are capped at **50** events for the analysis prompt.
- The LLM call is bounded at `temperature: 0.2`, `maxTokens: 1500`, `10 000 ms` timeout.
- Deleted agent (`agentId: null`) → fall back to `EVALUATION_DEFAULT_PROVIDER` / `EVALUATION_DEFAULT_MODEL` env vars (default `anthropic` / `claude-sonnet-4-6`).
- Malformed JSON from the model → one retry with a stricter prompt. Second failure → sanitized `500` error. **Raw LLM output is never forwarded.**

Response:

```jsonc
{
  "success": true,
  "data": {
    "session": {
      "sessionId": "cmj...",
      "status": "completed",
      "summary": "...",
      "improvementSuggestions": ["..."],
      "tokenUsage": { "input": 120, "output": 55 },
      "costUsd": 0,
    },
  },
}
```

Error mapping:

| Status | When                                        |
| ------ | ------------------------------------------- |
| 404    | Session missing or cross-user               |
| 409    | Session already `completed`                 |
| 400    | Session has no logs                         |
| 500    | Sanitized — raw provider/LLM errors dropped |
| 429    | Rate limit (`adminLimiter`)                 |

---

## Related

- [`.context/orchestration/admin-api.md`](../orchestration/admin-api.md) — Architecture + design rationale
- [`.context/orchestration/chat.md`](../orchestration/chat.md) — Streaming chat handler internals
- [`.context/orchestration/knowledge.md`](../orchestration/knowledge.md) — Knowledge base library API
- [`.context/orchestration/workflows.md`](../orchestration/workflows.md) — DAG validator + Phase 5.2 roadmap
- [`.context/api/sse.md`](./sse.md) — The `sseResponse` bridge helper consumed by `/chat/stream`
- `lib/validations/orchestration.ts` — All Zod schemas referenced above
- `types/orchestration.ts` — `ChatEvent`, `CostSummary`, `EvaluationStatus`, etc.
