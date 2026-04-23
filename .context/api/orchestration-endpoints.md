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

| Endpoint                            | Methods            | Purpose                                                 | Session |
| ----------------------------------- | ------------------ | ------------------------------------------------------- | ------- |
| `/agents`                           | GET, POST          | List / create agents                                    | 3.1     |
| `/agents/:id`                       | GET, PATCH, DELETE | Read / update / soft-delete                             | 3.1     |
| `/agents/:id/capabilities`          | POST               | Attach capability                                       | 3.1     |
| `/agents/:id/capabilities/:capId`   | PATCH, DELETE      | Update / detach pivot row                               | 3.1     |
| `/agents/:id/instructions-history`  | GET                | Read `systemInstructions` audit trail                   | 3.1     |
| `/agents/:id/instructions-revert`   | POST               | Revert to a previous `systemInstructions`               | 3.1     |
| `/agents/:id/clone`                 | POST               | Deep-clone agent with capability bindings               | 5.1     |
| `/agents/:id/capabilities/usage`    | GET                | Capability rate limit usage per slug (last 60s)         | 5.1     |
| `/agents/bulk`                      | POST               | Bulk activate/deactivate/delete agents                  | 5.1     |
| `/agents/compare`                   | GET                | Compare two agents side-by-side                         | 5.1     |
| `/agents/export`                    | POST               | Export selected agents as a bundle                      | 3.1     |
| `/agents/import`                    | POST               | Import an agent bundle                                  | 3.1     |
| `/capabilities`                     | GET, POST          | List / create capabilities                              | 3.1     |
| `/capabilities/:id`                 | GET, PATCH, DELETE | Read / update / soft-delete                             | 3.1     |
| `/capabilities/:id/stats`           | GET                | Capability execution metrics + daily breakdown          | 5.1     |
| `/providers`                        | GET, POST          | List / create LLM provider configs                      | 3.2     |
| `/providers/:id`                    | GET, PATCH, DELETE | Read / update / soft-delete                             | 3.2     |
| `/providers/:id/test`               | POST               | Live connection test                                    | 3.2     |
| `/providers/:id/test-model`         | POST               | Test a specific model via provider                      | 5.1     |
| `/providers/:id/health`             | GET, POST          | Read / reset circuit breaker state                      | 5.1     |
| `/providers/:id/models`             | GET                | Provider-reported models                                | 3.2     |
| `/models`                           | GET                | Aggregated model registry                               | 3.2     |
| `/provider-models`                  | GET, POST          | List / create provider model entries (selection matrix) | 5.2     |
| `/provider-models/:id`              | GET, PATCH, DELETE | Read / update / soft-delete provider model              | 5.2     |
| `/provider-models/recommend`        | GET                | Scored model recommendations by task intent             | 5.2     |
| `/workflows`                        | GET, POST          | List / create workflows                                 | 3.2     |
| `/workflows/:id`                    | GET, PATCH, DELETE | Read / update / soft-delete                             | 3.2     |
| `/workflows/:id/validate`           | POST               | DAG validation                                          | 3.2     |
| `/workflows/:id/dry-run`            | POST               | Validate + check inputData against template vars        | 5.1     |
| `/workflows/:id/execute`            | POST               | Run workflow (SSE `text/event-stream`)                  | 3.2     |
| `/workflows/:id/definition-history` | GET                | Workflow definition version history                     | 5.1     |
| `/workflows/:id/definition-revert`  | POST               | Revert to previous definition version                   | 5.1     |
| `/executions/:id`                   | GET                | Read execution + parsed trace                           | 3.2     |
| `/executions/:id/approve`           | POST               | Approve paused execution                                | 3.2     |
| `/executions/:id/cancel`            | POST               | Cancel a running/paused execution                       | 5.1     |
| `/executions/:id/retry-step`        | POST               | Retry from a failed step                                | 7.0     |
| `/chat/stream`                      | POST               | Streaming chat turn (SSE)                               | 3.3     |
| `/knowledge/search`                 | POST               | Hybrid vector + keyword search                          | 3.3     |
| `/knowledge/patterns/:number`       | GET                | Fetch all chunks for a single design pattern            | 3.3     |
| `/knowledge/documents`              | GET, POST          | List / upload document (multipart)                      | 3.3     |
| `/knowledge/documents/:id`          | GET, DELETE        | Read / delete document                                  | 3.3     |
| `/knowledge/documents/:id/rechunk`  | POST               | Rechunk + re-embed                                      | 3.3     |
| `/knowledge/seed`                   | POST               | Seed chunks (no embeddings) for design patterns         | 3.3     |
| `/knowledge/embed`                  | POST               | Generate embeddings for unembedded chunks               | 3.3     |
| `/knowledge/documents/:id/retry`    | POST               | Retry failed document ingestion                         | 5.1     |
| `/knowledge/graph`                  | GET                | Knowledge graph data (nodes + links)                    | 5.1     |
| `/knowledge/embedding-status`       | GET                | Embedding coverage stats + provider availability        | 3.3     |
| `/knowledge/meta-tags`              | GET                | Distinct categories and keywords with chunk/doc counts  | 9.0     |
| `/embedding-models`                 | GET                | Static registry of embedding models (filterable)        | 7.0     |
| `/conversations`                    | GET                | List caller's conversations                             | 3.3     |
| `/conversations/:id`                | GET, DELETE        | Read / delete one of the caller's conversations         | 3.3     |
| `/conversations/:id/messages`       | GET                | Read messages of one conversation                       | 3.3     |
| `/conversations/clear`              | POST               | Bulk-delete by filter (at least one filter required)    | 3.3     |
| `/costs`                            | GET                | Breakdown by day / agent / model                        | 3.4     |
| `/costs/summary`                    | GET                | Today / week / month + per-agent + trend                | 3.4     |
| `/costs/alerts`                     | GET                | Agents ≥ 80% of their budget                            | 3.4     |
| `/settings`                         | GET, PATCH         | Task-type defaults + global monthly budget cap          | 4.4     |
| `/agents/:id/budget`                | GET                | Read-only budget status                                 | 3.4     |
| `/evaluations`                      | GET, POST          | List caller's sessions / create                         | 3.4     |
| `/evaluations/:id`                  | GET, PATCH         | Read / update                                           | 3.4     |
| `/evaluations/:id/logs`             | GET                | Read log events                                         | 3.4     |
| `/evaluations/:id/complete`         | POST               | Run AI analysis and flip to `completed`                 | 3.4     |
| `/quiz-scores`                      | GET, POST          | List / save quiz scores (stored as evaluation sessions) | 6       |
| `/webhooks`                         | GET, POST          | List / create webhook subscriptions                     | 5.1     |
| `/webhooks/:id`                     | GET, PATCH, DELETE | Get / update / delete webhook subscription              | 5.1     |
| `/observability/dashboard-stats`    | GET                | Aggregated observability metrics                        | 5.1     |
| `/webhooks/:id/test`                | POST               | Send a test delivery to verify webhook endpoint         | 5.1     |
| `/webhooks/:id/deliveries`          | GET                | List delivery history for a subscription                | 5.1     |
| `/webhooks/deliveries/:id/retry`    | POST               | Retry a failed delivery                                 | 5.1     |
| `/analytics/engagement`             | GET                | Conversation volume, avg length, retention              | 6       |
| `/analytics/topics`                 | GET                | Popular topics grouped by frequency                     | 6       |
| `/analytics/unanswered`             | GET                | Messages with hedging phrases / low confidence          | 6       |
| `/analytics/content-gaps`           | GET                | Frequently asked topics with poor coverage              | 6       |
| `/analytics/feedback`               | GET                | Thumbs up/down aggregation and trend                    | 6       |
| `/agents/:id/invite-tokens`         | GET, POST          | List / create invite tokens for invite_only agents      | 5.1     |
| `/agents/:id/invite-tokens/:tid`    | PATCH, DELETE      | Update / revoke an invite token                         | 5.1     |
| `/agents/:id/versions`              | GET                | Version history (paginated snapshots)                   | 5.1     |
| `/workflows/templates`              | GET                | List workflow templates (builtin + custom)              | 5.1     |
| `/workflows/:id/save-as-template`   | POST               | Save a workflow as a reusable template                  | 5.1     |
| `/workflows/:id/schedules`          | GET, POST          | List / create cron schedules for a workflow             | 5.1     |
| `/workflows/:id/schedules/:sid`     | GET, PATCH, DELETE | Read / update / delete a workflow schedule              | 5.1     |
| `/executions`                       | GET                | List workflow executions (paginated)                    | 5.1     |
| `/conversations/export`             | POST               | Export conversations as JSON                            | 5.1     |
| `/conversations/:id/messages/:mid`  | GET                | Read a single message                                   | 5.1     |
| `/conversations/search`             | GET                | Full-text search across conversations                   | 5.1     |
| `/knowledge/patterns`               | GET                | List all design patterns                                | 3.3     |
| `/knowledge/documents/:id/confirm`  | POST               | Confirm a PDF preview and proceed with chunking         | 5.1     |
| `/hooks`                            | GET, POST          | List / create event hooks                               | 5.1     |
| `/hooks/:id`                        | GET, PATCH, DELETE | Read / update / delete an event hook                    | 5.1     |
| `/maintenance/tick`                 | POST               | Trigger maintenance (retention, retries, schedules)     | 5.1     |
| `/mcp/settings`                     | GET, PATCH         | MCP server configuration                                | 6       |
| `/mcp/tools`                        | GET                | List MCP-exposed tools                                  | 6       |
| `/mcp/tools/:id`                    | PATCH              | Toggle / configure MCP tool exposure                    | 6       |
| `/mcp/resources`                    | GET                | List MCP-exposed resources                              | 6       |
| `/mcp/resources/:id`                | PATCH              | Toggle / configure MCP resource exposure                | 6       |
| `/mcp/keys`                         | GET, POST          | List / create MCP API keys                              | 6       |
| `/mcp/keys/:id`                     | GET, PATCH, DELETE | Read / update / revoke MCP API key                      | 6       |
| `/mcp/keys/:id/rotate`              | POST               | Rotate an MCP API key                                   | 6       |
| `/mcp/audit`                        | GET                | Query MCP audit log                                     | 6       |
| `/mcp/sessions`                     | GET                | List MCP sessions                                       | 6       |
| `/mcp/sessions/:id`                 | GET                | Read a single MCP session                               | 6       |
| `/audit-log`                        | GET                | Admin action audit trail (paginated, filterable)        | 8       |

107 admin route files, 8 consumer chat route files, 1 webhook trigger route file (116 total). For architecture detail see `.context/orchestration/admin-api.md`.

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

Each item includes enriched fields inline: `_count: { capabilities, conversations }` and `_budget: { withinBudget, spent, limit, remaining, globalCapExceeded? } | null`. Budget is batch-computed via a single `groupBy` aggregate — no per-row queries. Types: `AiAgentListItem` in `types/orchestration.ts`.

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

### `POST /agents/:id/clone`

Deep-clones an agent including all capability bindings in a single transaction. The new agent gets a fresh (empty) `systemInstructionsHistory` and the session user as `createdBy`.

Optional body: `{ name?: string, slug?: string }`. Defaults: name = `"{source.name} (Copy)"`, slug = `"{source.slug}-copy"`. On slug collision, retries with `-copy-2` through `-copy-5`. Returns `201` on success, `409` if all slug variants are taken.

### `POST /agents/bulk`

Bulk agent operations. Body: `{ action: 'activate' | 'deactivate' | 'delete', agentIds: string[] }`. System agents (`isSystem = true`) are excluded from all mutations. Delete is a soft delete (sets `isActive = false`).

Response: `{ action, requested, affected }` — `affected` may be less than `requested` when system agents are filtered out.

### `GET /agents/compare`

Compare two agents side-by-side. Query: `agentIds=<cuid>,<cuid>` (exactly 2 required).

Returns `{ agents: [agentA, agentB] }` where each entry includes the agent config plus aggregated stats: `totalCostUsd`, `totalInputTokens`, `totalOutputTokens`, `llmCallCount`, `conversationCount`, `capabilityCount`, `evaluations: { total, completed }`.

### `GET /agents/:id/capabilities/usage`

Returns per-capability call counts within the last 60-second sliding window. Queries `AiCostLog` where `operation = 'tool_call'`, grouped by `metadata->>'slug'`.

Response: `{ usage: { "search_knowledge_base": 12, "get_pattern_detail": 3 } }`

### `POST /agents/export` / `POST /agents/import`

Versioned bundle format. Import runs in a single transaction with `conflictMode: 'skip' | 'overwrite'`. Capabilities are embedded by slug for cross-environment portability.

---

## Capabilities

### `GET /capabilities`

List. Query: `page`, `limit`, `isActive`, `q`.

Each item includes `_agents: Array<{ id, name, slug, isActive }>` — the agents currently using this capability, flattened from the `AiAgentCapability` pivot. Types: `AiCapabilityListItem` in `types/orchestration.ts`.

### `POST /capabilities`

Create. Body validated by `createCapabilitySchema` — `functionDefinition` must be a JSON Schema compatible with the LLM tool-use format.

### `GET / PATCH / DELETE /capabilities/:id`

Standard CRUD. `DELETE` is a soft delete. Dispatcher cache is cleared on every mutation.

### `GET /capabilities/:id/stats`

Aggregates execution metrics for a capability over a configurable period. Query: `period=7d|30d|90d` (default `30d`).

Response: `{ capabilityId, capabilitySlug, period, invocations, successRate, avgLatencyMs, p50LatencyMs, p95LatencyMs, totalCostUsd, dailyBreakdown: [{ date, invocations, successRate, costUsd }] }`.

Latency percentiles are computed from `AiEvaluationLog` entries with `executionTimeMs`. Invocation counts and cost come from `AiCostLog` where `operation = 'tool_call'`.

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

### `POST /providers/:id/test-model`

Sends a trivial prompt (`"Say hello."`, maxTokens: 10, temperature: 0) to a specific provider + model combination and reports round-trip latency. Body: `{ model: string }`.

Response: `{ ok: true, latencyMs: 246, model: "claude-sonnet-4-6" }` on success. On model failure: `{ ok: false, latencyMs: null, model }` at HTTP 200 (same convention as `/test`). Raw SDK errors are logged server-side but never forwarded.

### `GET / POST /providers/:id/health`

Circuit breaker status for a provider. `GET` returns `{ providerId, slug, state, failureCount, openedAt, config }`. When no breaker exists yet, returns a default `closed` state.

`POST` resets the breaker to closed (useful after a provider outage is resolved). Rate-limited by `adminLimiter`.

### `GET /providers/:id/models`

Asks the provider directly. Same error-sanitization guarantee as `/test`.

### `GET /models`

Aggregated registry across all configured providers. Query: `?refresh=true` to bypass the in-process cache.

---

## Provider Models (Selection Matrix)

### `GET /provider-models`

Paginated list of `AiProviderModel` entries enriched with `configured: boolean` and `configuredActive: boolean` (from matching `AiProviderConfig` by `providerSlug`). Filters: `capability` (`chat` | `embedding`), `providerSlug`, `tierRole`, `isActive`, `q` (text search across name, slug, providerSlug, modelId, description).

### `POST /provider-models`

Create a model entry. Body validated by `createProviderModelSchema`. Sets `isDefault: false`. Rate-limited by `adminLimiter`. Returns 409 on slug conflict.

### `GET / PATCH / DELETE /provider-models/:id`

Standard CRUD. `PATCH` sets `isDefault: false` on seed-managed rows (opt-out from future seed updates). `DELETE` is a soft delete (`isActive = false`). Both are rate-limited.

### `GET /provider-models/recommend?intent=thinking`

Scored model recommendations for a task intent. Query params: `intent` (required — `thinking`, `doing`, `fast_looping`, `high_reliability`, `private`, `embedding`), `limit` (optional, default 5, max 20). Response includes `recommendations[]` sorted by score and a `heuristic` object with human-readable rules.

---

## Workflows

### `GET /workflows` / `POST /workflows`

CRUD. The body is a `WorkflowDefinition` — a DAG of step nodes. Stored as `Json`. Each list item includes `_count: { executions: number }`. Types: `AiWorkflowListItem` in `types/orchestration.ts`.

### `GET / PATCH / DELETE /workflows/:id`

Standard CRUD.

### `POST /workflows/:id/validate`

Runs the pure-logic DAG validator from `lib/orchestration/workflows/validator.ts`. Checks duplicate ids, entry existence, unknown targets, reachability (BFS), cycle detection (DFS gray/black), and per-type config requirements. Returns `{ valid: true }` or `{ valid: false, errors: [{ code, message, path }] }`. Error codes are stable — render by `code`, never `message`.

### `POST /workflows/:id/dry-run`

Validates a workflow without executing it. Runs structural + semantic validation, then extracts `{{input.key}}` template variables and checks if `inputData` covers them. Body: `{ inputData: Record<string, unknown> }`.

Response: `{ ok, errors, warnings, extractedVariables }`. Warnings (uncovered template variables) are informational and do not set `ok: false`.

### `POST /workflows/:id/execute`

Runs a workflow as a live SSE `text/event-stream`. Body: `{ inputData, budgetLimitUsd? }`. See [`.context/orchestration/engine.md`](../orchestration/engine.md) for event types and lifecycle. Optional query param `?resumeFromExecutionId=<cuid>` resumes a paused execution.

### `GET /workflows/:id/definition-history`

Returns the workflow's current `workflowDefinition` plus the `workflowDefinitionHistory` array (newest first). Each entry carries an explicit `versionIndex` field referencing the raw (oldest-to-newest) DB array position -- the value `/definition-revert` expects.

Response: `{ workflowId, slug, current, history: [{ definition, changedAt, changedBy, versionIndex }] }`.

### `POST /workflows/:id/definition-revert`

Replaces the current `workflowDefinition` with the value at `workflowDefinitionHistory[versionIndex]`. The current value is pushed onto history before the swap so the revert itself is recoverable.

Body: `{ versionIndex: number }`. Returns the updated workflow.

### `GET /executions/:id`

Returns the execution row with a parsed `ExecutionTraceEntry[]`. Scoped to `session.user.id` — cross-user returns 404.

### `POST /executions/:id/approve`

Approves a `paused_for_approval` execution. Body: `{ approved: true }`. The execution resumes from the approval step. Non-paused executions return 400.

### `POST /executions/:id/cancel`

Cancels a `running` or `paused_for_approval` execution. Sets status to `cancelled` and records `completedAt`. The engine polls execution status between steps and stops when it sees `cancelled`.

Scoped to `session.user.id` — cross-user returns 404. Non-cancellable statuses return 400.

Response: `{ success: true, executionId }`

### `POST /executions/:id/retry-step`

Prepares a failed execution for retry from a specific step. Truncates the trace at the failed step, recalculates token/cost totals from remaining entries, and resets the execution status to `running`.

```jsonc
// Request
{ "stepId": "step-3" }

// Response
{
  "success": true,
  "data": {
    "success": true,
    "executionId": "<cuid>",
    "retryStepId": "step-3",
    "workflowId": "<cuid>"
  }
}
```

After this call, the client reconnects via `POST /workflows/:workflowId/execute?resumeFromExecutionId=<executionId>` to resume streaming from the failed step.

Guards: execution must be `failed`, `stepId` must reference a failed step in the trace, ownership is scoped to `session.user.id`.

---

## Chat (streaming)

### `POST /chat/stream`

Streams a single chat turn as **Server-Sent Events** (`text/event-stream`). Request body is validated by `chatStreamRequestSchema`:

```jsonc
{
  "agentSlug": "<slug>",
  "message": "User message text",
  "conversationId": "<cuid>", // optional — creates new conversation when absent
  "entityContext": {
    /* optional — record of string → unknown */
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

| `type`              | `data` shape                                                          | Meaning                                                              |
| ------------------- | --------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `start`             | `{ conversationId, messageId }`                                       | First event — conversation is ready and the assistant turn has begun |
| `content`           | `{ delta: string }`                                                   | Incremental assistant text                                           |
| `status`            | `{ message: string }`                                                 | Human-readable progress indicator                                    |
| `capability_result` | `{ capabilitySlug: string, result: unknown }`                         | A tool call completed — mid-stream                                   |
| `warning`           | `{ code, message }`                                                   | Non-terminal warning (e.g. budget at 80%) — stream continues         |
| `done`              | `{ tokenUsage: { inputTokens, outputTokens, totalTokens }, costUsd }` | Terminal success frame                                               |
| `error`             | `{ code, message }`                                                   | Terminal error frame                                                 |

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
  -d '{"agentSlug":"<slug>","message":"Hello"}'
```

`-N` disables buffering so frames arrive live.

#### JavaScript client (`ReadableStream`)

```ts
const res = await fetch('/api/v1/admin/orchestration/chat/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ agentSlug, message }),
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

Paginated document list. Query: `page`, `limit`, `status`, `category`, `q` (`listDocumentsQuerySchema`).

### `POST /knowledge/documents`

**Multipart upload.** Critical contract:

| Field        | Value                                                                               |
| ------------ | ----------------------------------------------------------------------------------- |
| Content-Type | `multipart/form-data`                                                               |
| Form field   | `file` (required)                                                                   |
| Form field   | `category` (optional — overrides any in-document `<!-- metadata: category=... -->`) |
| Max size     | **50 MB** (`MAX_UPLOAD_BYTES` in the route)                                         |
| Extensions   | **`.md`, `.markdown`, `.txt`, `.pdf`, `.docx`, `.epub`** (case-insensitive)         |
| MIME type    | Advisory only — the extension is the load-bearing check                             |

PDF uploads go through a preview flow (`requiresConfirmation: true`) where extracted text is returned for user confirmation before chunking. EPUB and DOCX are parsed via dedicated parsers. Do not `POST` with `application/json`; the route only accepts multipart.

Returns `201` with the created `AiKnowledgeDocument`. Files over 50 MB → `413 FILE_TOO_LARGE`. Disallowed extension → `400 INVALID_FILE_TYPE`.

### `GET / DELETE /knowledge/documents/:id`

Read / delete. Chunks cascade via the FK relation.

### `POST /knowledge/documents/:id/rechunk`

Re-runs the chunker + embedder. Blocked with `409 CONFLICT` when the document is already in `status: 'processing'` to prevent races.

### `POST /knowledge/seed`

**Phase 1** of the two-phase seeder. Inserts all chunks from the canonical `chunks.json` with `embedding = null` and sets the document status to `ready`. The Learning Patterns UI works immediately because it reads chunks directly — no embeddings needed. Returns `{ seeded: true }`. Idempotent: skips if the document already exists. If a previous attempt left a `failed` record, it is cleaned up and re-seeded. Safe to call on every deploy.

Knowledge documents are **global, not per-user**. `uploadedBy` is recorded for audit but is not a scope boundary.

### `POST /knowledge/embed`

**Phase 2** of the two-phase seeder. Finds all chunks where `embedding IS NULL`, batches them through the configured embedding provider, and writes vectors back. Returns `{ processed, total, alreadyEmbedded }`. Can be called repeatedly — only processes chunks that still need embeddings. Requires an active embedding provider (OpenAI API key or local provider like Ollama).

### `POST /knowledge/documents/:id/retry`

Retries a failed document ingestion. Only works on documents with `status: 'failed'`. Resets the document to `pending`, clears the error, and re-runs the chunker pipeline via `rechunkDocument()`.

Non-failed documents return `409 CONFLICT`.

### `GET /knowledge/graph`

Builds a hierarchical node/link graph for the knowledge base: central KB node, document nodes, and chunk nodes (if total chunks < 500). Query: `scope=system|app` (optional), `view=structure|embedded` (default: `structure`).

Response: `{ nodes, links, categories, stats: { documentCount, completedCount, chunkCount, totalTokens } }`. Each node has `id`, `name`, `type`, `value`, `category`, `metadata`. The `embedded` view filters to documents/chunks with embeddings.

### `GET /knowledge/embedding-status`

Lightweight status endpoint returning `{ total, embedded, pending, hasActiveProvider }`. Used by the Knowledge Base, Advisor, and Quiz UI to show an embedding coverage banner when search is partially available.

### `GET /knowledge/meta-tags`

Returns all distinct category and keyword values across knowledge base chunks, with counts of how many chunks and documents use each value. Used by the manage tab to display a meta-tags panel and by the upload form to power category autocomplete.

**Auth:** `withAdminAuth` + `adminLimiter`

**Response** (grouped by document scope):

```json
{
  "success": true,
  "data": {
    "app": {
      "categories": [{ "value": "sales", "chunkCount": 15, "documentCount": 3 }],
      "keywords": [{ "value": "pricing", "chunkCount": 5, "documentCount": 1 }]
    },
    "system": {
      "categories": [{ "value": "patterns", "chunkCount": 20, "documentCount": 1 }],
      "keywords": []
    }
  }
}
```

`app` contains tags from user-uploaded documents; `system` contains tags from the built-in seeded patterns. Categories come from the `category` column; keywords are extracted by unnesting the comma-separated `keywords` column via `string_to_array`. The SQL JOINs to `ai_knowledge_document` to get the `scope` field.

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

Paginated list of the caller's conversations. Query: `page`, `limit`, `agentId`, `isActive`, `q`, `messageSearch` (`listConversationsQuerySchema`). `messageSearch` filters to conversations containing at least one message whose `content` matches the search string (case-insensitive).

### `DELETE /conversations/:id`

Ownership-checked by `findFirst({ where: { id, userId: session.user.id } })`. Missing OR cross-user → `404`. Messages cascade.

### `GET /conversations/:id/messages`

Paginated. Same ownership check.

### `POST /conversations/clear`

Bulk delete by filter. Body validated by `clearConversationsBodySchema`:

```jsonc
{ "olderThan": "2025-01-01T00:00:00Z" }                      // caller's own
{ "agentId": "<cuid>" }                                       // caller's own
{ "agentId": "<cuid>", "userId": "<cuid>" }                  // target that user
{ "olderThan": "2025-01-01T00:00:00Z", "allUsers": true }    // all users, narrowed by date
```

**At least one of `olderThan` or `agentId` is required** — a Zod `.refine()` rejects empty bodies and `allUsers: true` alone. This is deliberate: an empty-body or unscoped "delete everything" call is a common tooling mistake; the schema makes it impossible.

Scope:

- default → caller's own conversations (`userId = session.user.id`)
- `userId` → a specific user
- `allUsers: true` → across all users (mutually exclusive with `userId`)

Cross-user deletions emit an `AiAdminAuditLog` entry (`conversation.bulk_clear`). Returns `{ deletedCount }`.

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

## Quiz Scores

### `GET /quiz-scores`

Returns the caller's quiz scores (most recent first, max 50). Scores are stored as `AiEvaluationSession` records with `metadata.quizScore`.

Response: `{ success: true, data: [{ id, correct, total, completedAt }] }`

### `POST /quiz-scores`

Saves a quiz score. Body: `{ correct: number, total: number }`. Creates an `AiEvaluationSession` linked to the `quiz-master` agent with `status: 'completed'`.

Response (201): `{ success: true, data: { id, correct, total } }`

| Status | When                   |
| ------ | ---------------------- |
| 400    | Validation failure     |
| 401    | Unauthenticated        |
| 403    | Not admin              |
| 429    | Rate limit (POST only) |

---

## Webhooks

**Scoped to `session.user.id`.** Admins manage their own webhook subscriptions.

### `GET /webhooks`

Paginated list of the caller's webhook subscriptions. Query: `page`, `limit`, `isActive`.

### `POST /webhooks`

Create a webhook subscription. Body: `{ url: string, secret?: string, events: string[], description?: string, isActive?: boolean }`. Returns `201` with the created subscription (secret is never returned in responses).

### `GET / PATCH / DELETE /webhooks/:id`

Standard CRUD for a single webhook subscription. Scoped to `session.user.id` — cross-user returns 404. `PATCH` body: `{ url?, events?, description?, isActive? }`. `DELETE` is a hard delete.

---

## Observability

### `GET /observability/dashboard-stats`

Aggregated metrics for the observability dashboard. Returns in a single batched query:

- `activeConversations` — count of active conversations for the caller
- `todayRequests` — cost log entries since UTC midnight
- `errorRate` — failed / total executions in last 24h (caller-scoped)
- `recentErrors` — last 5 failed executions with `id`, `errorMessage`, `workflowId`, `createdAt`
- `topCapabilities` — top 10 capabilities by invocation count: `[{ slug, count }]`

Supports `ETag` / `If-None-Match` for conditional GET (returns 304 when unchanged).

---

## Related

- [`.context/orchestration/admin-api.md`](../orchestration/admin-api.md) — Architecture + design rationale
- [`.context/orchestration/chat.md`](../orchestration/chat.md) — Streaming chat handler internals
- [`.context/orchestration/knowledge.md`](../orchestration/knowledge.md) — Knowledge base library API
- [`.context/orchestration/workflows.md`](../orchestration/workflows.md) — DAG validator + Phase 5.2 roadmap
- [`.context/api/sse.md`](./sse.md) — The `sseResponse` bridge helper consumed by `/chat/stream`
- `lib/validations/orchestration.ts` — All Zod schemas referenced above
- `types/orchestration.ts` — `ChatEvent`, `CostSummary`, `EvaluationStatus`, etc.
