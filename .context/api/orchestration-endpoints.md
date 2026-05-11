# Agent Orchestration API Endpoints

Consumer-focused HTTP reference for every admin orchestration endpoint, consolidated across Phase 3 sessions 3.1 – 3.4. For architecture and design rationale see the per-domain docs under `.context/orchestration/`.

**Base path:** `/api/v1/admin/orchestration`
**Authentication:** Every endpoint requires a session with the `ADMIN` role (`withAdminAuth` in `lib/auth/guards.ts`). Non-admins get `403`, unauthenticated callers get `401`.
**Rate limiting:** Every mutating handler (`POST`, `PATCH`, `DELETE`) is gated by `adminLimiter` (30 req/min per IP, see `lib/security/rate-limit.ts`). Most `GET` routes are unlimited; some sub-resource GETs (capabilities list, capabilities usage, embed-tokens list, invite-tokens list, compare) are also rate-limited.
**Response envelope:**

```jsonc
// Success
{ "success": true, "data": <payload>, "meta": { /* optional pagination */ } }

// Error
{ "success": false, "error": { "code": "ERROR_CODE", "message": "...", "details": { /* optional */ } } }
```

Validation schemas for every request body / query live in `lib/validations/orchestration.ts`. Typed errors (`NotFoundError`, `ValidationError`, `ConflictError`) funnel through `handleAPIError`.

## Quick reference

| Endpoint                                  | Methods            | Purpose                                                                                              | Session |
| ----------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------------------- | ------- |
| `/agents`                                 | GET, POST          | List / create agents                                                                                 | 3.1     |
| `/agents/:id`                             | GET, PATCH, DELETE | Read / update / soft-delete                                                                          | 3.1     |
| `/agents/:id/capabilities`                | GET, POST          | List attached / attach capability                                                                    | 3.1     |
| `/agents/:id/capabilities/:capId`         | PATCH, DELETE      | Update / detach pivot row                                                                            | 3.1     |
| `/agents/:id/instructions-history`        | GET                | Read `systemInstructions` audit trail                                                                | 3.1     |
| `/agents/:id/instructions-revert`         | POST               | Revert to a previous `systemInstructions`                                                            | 3.1     |
| `/agents/:id/clone`                       | POST               | Deep-clone agent with capability bindings                                                            | 5.1     |
| `/agents/:id/capabilities/usage`          | GET                | Capability rate limit usage per slug (last 60s)                                                      | 5.1     |
| `/agents/bulk`                            | POST               | Bulk activate/deactivate/delete agents                                                               | 5.1     |
| `/agents/compare`                         | GET                | Compare two agents side-by-side                                                                      | 5.1     |
| `/agents/export`                          | POST               | Export selected agents as a bundle                                                                   | 3.1     |
| `/agents/import`                          | POST               | Import an agent bundle                                                                               | 3.1     |
| `/capabilities`                           | GET, POST          | List / create capabilities                                                                           | 3.1     |
| `/capabilities/:id`                       | GET, PATCH, DELETE | Read / update / soft-delete                                                                          | 3.1     |
| `/capabilities/:id/stats`                 | GET                | Capability execution metrics + daily breakdown                                                       | 5.1     |
| `/providers`                              | GET, POST          | List / create LLM provider configs                                                                   | 3.2     |
| `/providers/:id`                          | GET, PATCH, DELETE | Read / update / soft-delete                                                                          | 3.2     |
| `/providers/:id/test`                     | POST               | Live connection test                                                                                 | 3.2     |
| `/providers/:id/test-model`               | POST               | Test a specific model via provider                                                                   | 5.1     |
| `/providers/:id/health`                   | GET, POST          | Read / reset circuit breaker state                                                                   | 5.1     |
| `/providers/:id/models`                   | GET                | Provider-reported models                                                                             | 3.2     |
| `/providers/detect`                       | GET                | Scan `process.env` for known provider API keys; returns booleans + suggested config (no values)      | 5.3     |
| `/providers/test-bulk`                    | POST               | Run `testConnection()` on up to 50 providers in one round trip — replaces the list-mount N+1 fan-out | 5.3     |
| `/models`                                 | GET                | Aggregated model registry                                                                            | 3.2     |
| `/provider-models`                        | GET, POST          | List / create provider model entries (selection matrix)                                              | 5.2     |
| `/provider-models/bulk`                   | POST               | Bulk-create up to 50 models in one request (powers the discovery dialog)                             | 5.3     |
| `/provider-models/:id`                    | GET, PATCH, DELETE | Read / update / soft-delete provider model                                                           | 5.2     |
| `/provider-models/recommend`              | GET                | Scored model recommendations by task intent                                                          | 5.2     |
| `/discovery/models?providerSlug=X`        | GET                | Two-tier candidate fan-out (vendor SDK + OpenRouter cache) with heuristic-derived matrix suggestions | 5.3     |
| `/workflows`                              | GET, POST          | List / create workflows                                                                              | 3.2     |
| `/workflows/:id`                          | GET, PATCH, DELETE | Read / update / soft-delete                                                                          | 3.2     |
| `/workflows/:id/validate`                 | POST               | DAG validation                                                                                       | 3.2     |
| `/workflows/:id/dry-run`                  | POST               | Validate + check inputData against template vars                                                     | 5.1     |
| `/workflows/:id/execute`                  | POST               | Run workflow (SSE `text/event-stream`)                                                               | 3.2     |
| `/workflows/:id/execute-stream`           | GET                | Run workflow via EventSource (SSE GET)                                                               | 5.1     |
| `/workflows/:id/versions`                 | GET                | List published versions (paginated, desc by version)                                                 | 5.1     |
| `/workflows/:id/versions/:version`        | GET                | Single-version snapshot read                                                                         | 5.1     |
| `/workflows/:id/publish`                  | POST               | Promote `draftDefinition` to a new published version                                                 | 5.1     |
| `/workflows/:id/discard-draft`            | POST               | Clear `draftDefinition`; published version unchanged                                                 | 5.1     |
| `/workflows/:id/rollback`                 | POST               | Create a NEW version copied from a target version                                                    | 5.1     |
| `/executions/:id`                         | GET                | Read execution + parsed trace                                                                        | 3.2     |
| `/executions/:id/status`                  | GET                | Lightweight status read (no trace, polling-friendly)                                                 | —       |
| `/executions/:id/approve`                 | POST               | Approve paused execution                                                                             | 3.2     |
| `/executions/:id/reject`                  | POST               | Reject paused execution with reason                                                                  | —       |
| `/executions/:id/cancel`                  | POST               | Cancel a running/paused execution                                                                    | 5.1     |
| `/executions/:id/retry-step`              | POST               | Retry from a failed step                                                                             | 7.0     |
| `/chat/stream`                            | POST               | Streaming chat turn (SSE)                                                                            | 3.3     |
| `/chat/transcribe`                        | POST               | Speech-to-text — multipart audio in, transcript out                                                  | —       |
| `/knowledge/search`                       | POST               | Hybrid vector + keyword search                                                                       | 3.3     |
| `/knowledge/patterns/:number`             | GET                | Fetch all chunks for a single design pattern                                                         | 3.3     |
| `/knowledge/documents`                    | GET, POST          | List / upload document (multipart)                                                                   | 3.3     |
| `/knowledge/documents/:id`                | GET, DELETE        | Read / delete document                                                                               | 3.3     |
| `/knowledge/documents/:id/rechunk`        | POST               | Rechunk + re-embed                                                                                   | 3.3     |
| `/knowledge/seed`                         | POST               | Seed chunks (no embeddings) for design patterns                                                      | 3.3     |
| `/knowledge/embed`                        | POST               | Generate embeddings for unembedded chunks                                                            | 3.3     |
| `/knowledge/documents/:id/retry`          | POST               | Retry failed document ingestion                                                                      | 5.1     |
| `/knowledge/graph`                        | GET                | Knowledge graph data (nodes + links)                                                                 | 5.1     |
| `/knowledge/embeddings`                   | GET                | UMAP-projected 2D coordinates for every embedded chunk (drives the Visualize tab's Embedding space)  | 9.1     |
| `/knowledge/embedding-status`             | GET                | Embedding coverage stats + provider availability                                                     | 3.3     |
| `/knowledge/meta-tags`                    | GET                | Distinct categories and keywords with chunk/doc counts                                               | 9.0     |
| `/embedding-models`                       | GET                | Static registry of embedding models (filterable)                                                     | 7.0     |
| `/conversations`                          | GET                | List caller's conversations                                                                          | 3.3     |
| `/conversations/:id`                      | GET, DELETE        | Read / delete one of the caller's conversations                                                      | 3.3     |
| `/conversations/:id/messages`             | GET                | Read messages of one conversation                                                                    | 3.3     |
| `/conversations/clear`                    | POST               | Bulk-delete by filter (at least one filter required)                                                 | 3.3     |
| `/costs`                                  | GET                | Breakdown by day / agent / model                                                                     | 3.4     |
| `/costs/summary`                          | GET                | Today / week / month + per-agent + trend                                                             | 3.4     |
| `/costs/alerts`                           | GET                | Agents ≥ 80% of their budget                                                                         | 3.4     |
| `/settings`                               | GET, PATCH         | Task-type defaults + global monthly budget cap                                                       | 4.4     |
| `/agents/:id/budget`                      | GET                | Read-only budget status                                                                              | 3.4     |
| `/agents/:id/evaluation-trend`            | GET                | Per-agent F/G/R quality trend across completed sessions                                              | 7.6     |
| `/evaluations`                            | GET, POST          | List caller's sessions / create                                                                      | 3.4     |
| `/evaluations/:id`                        | GET, PATCH         | Read / update                                                                                        | 3.4     |
| `/evaluations/:id/logs`                   | GET                | Read log events                                                                                      | 3.4     |
| `/evaluations/:id/complete`               | POST               | Run AI analysis + named-metric scoring                                                               | 3.4     |
| `/evaluations/:id/rescore`                | POST               | Re-run named-metric scoring on a completed session                                                   | 7.6     |
| `/quiz-scores`                            | GET, POST          | List / save quiz scores (stored as evaluation sessions)                                              | 6       |
| `/webhooks`                               | GET, POST          | List / create webhook subscriptions                                                                  | 5.1     |
| `/webhooks/:id`                           | GET, PATCH, DELETE | Get / update / delete webhook subscription                                                           | 5.1     |
| `/observability/dashboard-stats`          | GET                | Aggregated observability metrics                                                                     | 5.1     |
| `/webhooks/:id/test`                      | POST               | Send test ping (requires signing secret)                                                             | 5.1     |
| `/webhooks/:id/deliveries`                | GET                | List delivery history (owner-scoped)                                                                 | 5.1     |
| `/webhooks/deliveries/:id/retry`          | POST               | Retry a failed delivery (owner-scoped)                                                               | 5.1     |
| `/hooks/:id/deliveries`                   | GET                | Paginated delivery history for an event hook                                                         | 5.1     |
| `/hooks/:id/rotate-secret`                | POST, DELETE       | Rotate or clear event hook HMAC signing secret                                                       | 5.1     |
| `/hooks/deliveries/:id/retry`             | POST               | Retry a failed / exhausted event-hook delivery                                                       | 5.1     |
| `/analytics/engagement`                   | GET                | Conversation volume, avg length, retention                                                           | 6       |
| `/analytics/topics`                       | GET                | Popular topics grouped by frequency                                                                  | 6       |
| `/analytics/unanswered`                   | GET                | Messages with hedging phrases / low confidence                                                       | 6       |
| `/analytics/content-gaps`                 | GET                | Frequently asked topics with poor coverage                                                           | 6       |
| `/analytics/feedback`                     | GET                | Thumbs up/down aggregation and trend                                                                 | 6       |
| `/agents/:id/invite-tokens`               | GET, POST          | List / create invite tokens for invite_only agents                                                   | 5.1     |
| `/agents/:id/invite-tokens/:tokenId`      | DELETE             | Revoke an invite token                                                                               | 5.1     |
| `/agents/:id/versions`                    | GET                | Version history (paginated snapshots)                                                                | 5.1     |
| `/agents/:id/versions/:versionId`         | GET                | Get version detail (full snapshot)                                                                   | 5.1     |
| `/agents/:id/versions/:versionId/restore` | POST               | Restore agent from a version snapshot                                                                | 5.1     |
| `/agents/:id/embed-tokens`                | GET, POST          | List / create embed tokens for widget auth                                                           | 5.1     |
| `/agents/:id/embed-tokens/:tokenId`       | PATCH, DELETE      | Update / delete an embed token                                                                       | 5.1     |
| `/agents/:id/widget-config`               | GET, PATCH         | Read / update per-agent widget appearance + copy                                                     | 5.1     |
| `/workflows/templates`                    | GET                | List workflow templates (builtin + custom)                                                           | 5.1     |
| `/workflows/:id/save-as-template`         | POST               | Save a workflow as a reusable template                                                               | 5.1     |
| `/workflows/:id/schedules`                | GET, POST          | List / create cron schedules for a workflow                                                          | 5.1     |
| `/workflows/:id/schedules/:scheduleId`    | GET, PATCH, DELETE | Read / update / delete a workflow schedule                                                           | 5.1     |

**Schedule constraints:** Maximum 10 schedules per workflow. Workflow must be active (`isActive: true`) to create schedules. Create, update, and delete operations are audit-logged via `logAdminAction`.

| `/executions` | GET | List workflow executions (paginated) | 5.1 |
| `/conversations/export` | POST | Export conversations as JSON | 5.1 |
| `/conversations/:id/messages` | GET | List messages for a conversation | 5.1 |
| `/conversations/search` | GET | Full-text search across conversations | 5.1 |
| `/knowledge/patterns` | GET | List all design patterns | 3.3 |
| `/knowledge/documents/:id/confirm` | POST | Confirm a PDF preview and proceed with chunking | 5.1 |
| `/hooks` | GET, POST | List / create event hooks | 5.1 |
| `/hooks/:id` | GET, PATCH, DELETE | Read / update / delete an event hook | 5.1 |
| `/maintenance/tick` | POST | Trigger maintenance (retention, retries, schedules) | 5.1 |
| `/mcp/settings` | GET, PATCH | MCP server configuration | 6 |
| `/mcp/tools` | GET | List MCP-exposed tools | 6 |
| `/mcp/tools/:id` | PATCH | Toggle / configure MCP tool exposure | 6 |
| `/mcp/resources` | GET | List MCP-exposed resources | 6 |
| `/mcp/resources/:id` | PATCH | Toggle / configure MCP resource exposure | 6 |
| `/mcp/keys` | GET, POST | List / create MCP API keys | 6 |
| `/mcp/keys/:id` | GET, PATCH, DELETE | Read / update / revoke MCP API key | 6 |
| `/mcp/keys/:id/rotate` | POST | Rotate an MCP API key | 6 |
| `/mcp/audit` | GET | Query MCP audit log | 6 |
| `/mcp/sessions` | GET | List MCP sessions | 6 |
| `/mcp/sessions/:id` | GET | Read a single MCP session | 6 |
| `/audit-log` | GET | Admin action audit trail (paginated, filterable) | 8 |

120 admin route files, 8 consumer chat route files, 1 webhook trigger route file, 2 public approval route files (131 total). For architecture detail see `.context/orchestration/admin-api.md`.

### Public Approval Endpoints (Token-Authenticated)

These endpoints live outside the admin base path and require no session — a signed HMAC token in the query string is the authorization.

| Endpoint                                      | Methods | Purpose                                   | Auth       |
| --------------------------------------------- | ------- | ----------------------------------------- | ---------- |
| `/api/v1/orchestration/approvals/:id/approve` | POST    | Approve via signed token                  | `?token=…` |
| `/api/v1/orchestration/approvals/:id/reject`  | POST    | Reject via signed token (reason required) | `?token=…` |

Rate limited via `apiLimiter`. See [Event Hooks — External Approval Endpoints](../orchestration/hooks.md#external-approval-endpoints) for details.

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

Sends a trivial prompt to a specific provider + model combination and reports round-trip latency.

Body: `{ model: string, capability?: 'chat' | 'reasoning' | 'embedding' | 'image' | 'audio' | 'moderation' | 'unknown' }`. `capability` defaults to `'chat'` for backwards compatibility with pre-Phase B callers (the wizard smoke test and the agent-form test card). The route routes by capability:

- **`chat`** — `provider.chat([{ role: 'user', content: 'Say hello.' }], { model, maxTokens: 10, temperature: 0 })`
- **`embedding`** — `provider.embed('hello')` (cheaper than chat; exercises the same auth + base URL surface)
- **`reasoning` / `image` / `audio` / `moderation` / `unknown`** — refused without an SDK call; returns `{ ok: false, error: 'unsupported_test_capability', message: <human-readable reason> }`

Response: HTTP 200 with `{ ok: true, latencyMs: 246, model, capability }` on success. On model failure: `{ ok: false, latencyMs: null, model, capability, error: 'model_test_failed' }`. Raw SDK errors are logged server-side but never forwarded — the panel keys off the stable `error` string to distinguish failure modes from unsupported capabilities.

### `GET / POST /providers/:id/health`

Circuit breaker status for a provider. `GET` returns `{ providerId, slug, state, failureCount, openedAt, config }`. When no breaker exists yet, returns a default `closed` state.

`POST` resets the breaker to closed (useful after a provider outage is resolved). Rate-limited by `adminLimiter`.

### `GET /providers/:id/models`

Live model listing for a single provider. Behaviour:

1. **Rate-limited** by `adminLimiter` (returns 429 on excess).
2. **API key check** — non-local providers without their `apiKeyEnvVar` set return 422 `API_KEY_MISSING` (no SDK call attempted).
3. **OpenRouter refresh** — for non-local providers, `await refreshFromOpenRouter()` runs before listing so the registry's `getModel(id)` lookup returns live context + pricing instead of the static fallback's zeros. Idempotent and 24h-cached. Skipped for local providers — their models aren't in OpenRouter and the call would be wasted on fully-local setups.
4. **`provider.listModels()`** — asks the SDK what's available. Each result is enriched via `getModel(id)` against the now-refreshed registry.
5. **Matrix LEFT JOIN** — annotates each row with `inMatrix: boolean`, `matrixId: string | null`, `capabilities: string[]`, `tierRole: string | null` from `AiProviderModel`. Capabilities from the matrix take precedence; unmatched rows fall back to `inferCapability(slug, modelId)` so they still get a meaningful badge + a routed Test button.
6. **Agents LEFT JOIN** — annotates each row with `agents: Array<{ id, name, slug }>` for active `AiAgent` rows bound to `(provider, modelId)`. Powers the "agents using this model" column in the View Models panel.

Returns 503 `PROVIDER_UNAVAILABLE` if `listModels` throws — same error-sanitization guarantee as `/test` (raw SDK errors are logged server-side but never forwarded).

### `GET /providers/detect`

Scans `process.env` for known LLM provider API keys (catalogue: `lib/orchestration/llm/known-providers.ts`) and returns one row per known provider with `apiKeyPresent: boolean`, `apiKeyEnvVar: string | null`, `alreadyConfigured: boolean`, plus the suggested `defaultBaseUrl` and per-task model picks. **Env-var values never leave the server** — only the var _name_ is reported when the key is present, never its value. Used by the setup wizard's "We detected X — configure now?" cards on a fresh install. `alreadyConfigured` is keyed off the existing `slug` so the wizard can hide duplicates.

### `POST /providers/test-bulk`

Body: `{ providerIds: string[] }` (1–50 cuids). Loads every requested provider in a single `findMany`, runs `testConnection()` for each concurrently with `Promise.allSettled`, and returns `{ results: Array<{ id, ok, models, error? }> }`. Replaces the previous client-side N+1 pattern where `providers-list.tsx` fired one `POST /providers/:id/test` per provider on mount. Each row carries the same sanitised error contract as the single-id endpoint — raw SDK errors are logged server-side but never forwarded to the caller, so the route can't be used as a blind-SSRF port scanner. Provider ids that don't exist in the database are silently dropped from the response (mirrors how the single-id endpoint would 404).

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

### `GET /workflows/:id/execute-stream`

Alternative to `POST /execute` for clients that prefer GET-based SSE (the browser `EventSource` API requires GET). Input is passed as query params: `?inputData=<json>&budgetLimitUsd=<number>`. Events are identical to the POST variant. On client disconnect, execution continues server-side but stops streaming.

### `GET /workflows/:id/definition-history`

Returns the workflow's current `workflowDefinition` plus the `workflowDefinitionHistory` array (newest first). Each entry carries an explicit `versionIndex` field referencing the raw (oldest-to-newest) DB array position -- the value `/definition-revert` expects.

Response: `{ workflowId, slug, current, history: [{ definition, changedAt, changedBy, versionIndex }] }`.

### `POST /workflows/:id/definition-revert`

Replaces the current `workflowDefinition` with the value at `workflowDefinitionHistory[versionIndex]`. The current value is pushed onto history before the swap so the revert itself is recoverable.

Body: `{ versionIndex: number }`. Returns the updated workflow.

**Constraints:**

- `versionIndex` is bounds-checked against history length (out-of-range returns 400)
- Optimistic locking via `updatedAt` in the WHERE clause prevents concurrent reverts
- History is capped at 50 entries (oldest trimmed first)
- The target definition is validated against the current schema — old incompatible definitions may be rejected
- Audit-logged via `logAdminAction`

### `GET /executions/:id`

Returns the execution row with a parsed `ExecutionTraceEntry[]`. Scoped to `session.user.id` — cross-user returns 404.

### `POST /executions/:id/approve`

Approves a `paused_for_approval` execution. Body: `{ notes?: string, approvalPayload?: object }`. The execution resumes from the approval step (status → `pending`, awaiting trace entry → `completed`). Non-paused executions return 400. Concurrent races return 409.

Scoped to `session.user.id` OR approver delegation — if the caller's ID is in the `approverUserIds` list from the trace's `awaiting_approval` output entry, access is allowed even if they don't own the execution. Non-authorized users get 404 (not 403).

Delegates to shared `executeApproval()` in `lib/orchestration/approval-actions.ts`.

### `POST /executions/:id/reject`

Rejects a `paused_for_approval` execution with a required reason. Sets status to `cancelled`, `errorMessage` to `"Rejected: <reason>"`, and `completedAt` to now. Non-paused executions return 400. Corrupted execution traces (missing `awaiting_approval` entry) return 400. Concurrent races return 409.

```jsonc
// Request
{ "reason": "Does not meet compliance requirements" }

// Response
{ "success": true, "data": { "success": true, "executionId": "<cuid>" } }
```

Same ownership + approver scoping as approve. Delegates to shared `executeRejection()` in `lib/orchestration/approval-actions.ts`.

### `POST /executions/:id/cancel`

Cancels a `running` or `paused_for_approval` execution. Sets status to `cancelled` and records `completedAt`. The engine polls execution status between steps and stops when it sees `cancelled`.

Scoped to `session.user.id` — cross-user returns 404. Non-cancellable statuses return 400. Delegated approvers (listed in the step's `approverUserIds`) can cancel `paused_for_approval` executions they are authorised for, but not `running` executions. Concurrent status changes return 409.

Response: `{ success: true, executionId }`

### `POST /executions/:id/retry-step`

Prepares a failed execution for retry from a specific step. Truncates the trace at the failed step, recalculates token/cost totals from remaining entries, and resets the execution status to `pending` (not `running` — signals "ready to resume but no engine attached yet").

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

| `type`               | `data` shape                                                                             | Meaning                                                              |
| -------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `start`              | `{ conversationId, messageId }`                                                          | First event — conversation is ready and the assistant turn has begun |
| `content`            | `{ delta: string }`                                                                      | Incremental assistant text                                           |
| `status`             | `{ message: string }`                                                                    | Human-readable progress indicator                                    |
| `capability_result`  | `{ capabilitySlug: string, result: unknown }`                                            | A single tool call completed — mid-stream                            |
| `capability_results` | `{ results: { capabilitySlug: string, result: unknown }[] }`                             | Batch of parallel tool calls completed — mid-stream                  |
| `warning`            | `{ code, message }`                                                                      | Non-terminal warning (e.g. budget at 80%) — stream continues         |
| `content_reset`      | `{}`                                                                                     | Provider fallback — client must clear buffered content and restart   |
| `done`               | `{ tokenUsage: { inputTokens, outputTokens, totalTokens }, costUsd, provider?, model? }` | Terminal success frame                                               |
| `error`              | `{ code, message }`                                                                      | Terminal error frame                                                 |

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

### `POST /chat/transcribe`

Speech-to-text upload. Accepts a multipart/form-data body, returns the transcribed text plus the audio duration so the chat surface can populate its input field.

**Auth:** Admin session.
**Rate limit:** `audioLimiter` (10 req/min, keyed by `audio:user:${userId}`).
**Runtime:** `nodejs` with `maxDuration = 60`.

**Form fields:**

| Field      | Type     | Required | Notes                                                                               |
| ---------- | -------- | -------- | ----------------------------------------------------------------------------------- |
| `audio`    | `File`   | yes      | Audio bytes. Max 25 MB. MIME must start with one of `audio/{webm,mp4,mpeg,wav,ogg}` |
| `agentId`  | `string` | yes      | Agent the transcript is destined for (gates the per-agent voice toggle)             |
| `language` | `string` | no       | ISO 639-1 hint (e.g. `en`, `es`); helps Whisper short-circuit auto-detect           |

**Success:** `200 { success: true, data: { text, durationMs, language? } }`.

**Error envelope codes:**

- `MISSING_AUDIO` (400) — no `audio` field in the body.
- `AUDIO_EMPTY` (400) — zero-byte audio.
- `AUDIO_TOO_LARGE` (413) — exceeds the 25 MB cap. Fires either pre-parse from the `Content-Length` header (heap protection) or post-parse from the file size check.
- `AUDIO_INVALID_TYPE` (415) — MIME not in the allowlist.
- `MISSING_AGENT_ID` (400) — `agentId` field absent.
- `INVALID_LANGUAGE` (400) — language hint doesn't match the ISO 639-1 pattern.
- `VOICE_DISABLED` (403) — per-agent toggle off, or org-wide kill switch off.
- `NOT_FOUND` (404) — agent doesn't exist or is inactive.
- `NO_AUDIO_PROVIDER` (503) — no `AiProviderModel` row with the `'audio'` capability.
- `TRANSCRIPTION_FAILED` (502) — provider raised. Sanitised; check server logs.

**Behaviour:** writes a `CostOperation = 'transcription'` row to `AiCostLog` tagged to the agent (per-minute pricing via `WHISPER_USD_PER_MINUTE * durationMs / 60_000`; `metadata.durationMs` set). Audio bytes are not persisted — the route handler is asserted by `tests/integration/api/v1/admin/orchestration/chat.transcribe.test.ts` to never call any AiMessage / AiConversation / AiKnowledge write.

**Platform body-size caveat:** the 25 MB cap is Sunrise's server-side limit. Vercel deployments (Hobby and default Pro) reject bodies over **4.5 MB** at the edge before the route runs. Self-hosted Node / Docker get the full 25 MB. See `.context/orchestration/embed.md#platform-body-size-limits` for the platform comparison.

```bash
curl -X POST /api/v1/admin/orchestration/chat/transcribe \
  -H "Cookie: session=..." \
  -F "audio=@voice.webm;type=audio/webm" \
  -F "agentId=cmjbv4i3x0..."
```

### Image and PDF attachments on `POST /chat/stream`

Image and PDF inputs share the streaming-chat endpoint rather than getting their own route. Attachments ride in the request body as `chatAttachmentsArraySchema` entries (`{ name, mediaType, data }`, base64-encoded). Three error codes specific to attachments can surface; magic-byte and rate-limit failures arrive as regular HTTP errors before SSE begins, while capability and toggle failures arrive as SSE `error` events.

**Pre-stream HTTP errors** (returned via `errorResponse`):

- `IMAGE_INVALID_TYPE` (415) — magic-byte validation rejected an `image/*` or `application/pdf` attachment. Body claims a MIME the bytes don't match. Both admin and consumer routes check this in front of `streamChat`.
- 429 with rate-limit headers — `imageLimiter` exceeded (20 attachment-bearing requests / minute / user, keyed `image:user:${userId}`).

**SSE error events** (terminal — emitted by `streaming-handler.ts`):

- `IMAGE_DISABLED` — `agent.enableImageInput=false`, or `AiOrchestrationSettings.imageInputGloballyEnabled=false`.
- `PDF_DISABLED` — `agent.enableDocumentInput=false`, or `AiOrchestrationSettings.documentInputGloballyEnabled=false`.
- `IMAGE_NOT_SUPPORTED` — resolved chat model lacks the `'vision'` capability. Map: switch model.
- `PDF_NOT_SUPPORTED` — resolved chat model lacks the `'documents'` capability. Map: switch to a Claude family model.

**Behaviour:** when at least one image or PDF passes the gates, a single `CostOperation = 'vision'` row is written to `AiCostLog` tagged to the agent with `metadata.imageCount` / `metadata.pdfCount`. Per-token chat cost rolls up under separate `chat` rows. Attachment bytes are not persisted — the chat handler only stores the user's text plus the assistant's response.

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

### `GET /knowledge/embeddings`

Returns chunk metadata plus a 2D UMAP projection of each chunk's 1,536-dimension embedding vector. Drives the **Embedding space** view in the admin Visualize tab — points cluster by semantic similarity (UMAP preserves local-neighbour structure during the dimensionality reduction).

**Why server-side UMAP, not client-side.** Each chunk's raw embedding is a 1,536-dim Float64; shipping 1,000 chunks would push ~12 MB of JSON to the browser. Running UMAP server-side and returning two floats per chunk drops the payload by ~99 % while still letting the browser render the scatter plot.

**Stability.** UMAP is non-deterministic by default. The route passes a seeded PRNG (mulberry32) to the algorithm so successive requests against the same dataset produce the same coordinates — without that, every refresh would shuffle the cluster positions and break the user's spatial memory.

**Query params:**

- `scope` (optional): `system` | `app`
- `limit` (optional, default `2000`, max `5000`): cap on returned chunks. When the embedded chunk count exceeds this, the route samples uniformly (every `ceil(totalEmbedded / limit)`-th chunk by id ordering) and sets `stats.truncated: true`.
- `nNeighbors` (optional, default `15`): UMAP's `nNeighbors` parameter. Clamped to `(totalPoints - 1)` if too high for the dataset size.

**Response:**

```jsonc
{
  "success": true,
  "data": {
    "chunks": [
      {
        "id": "chunk-...",
        "documentId": "doc-...",
        "documentName": "HCE Studio Whitepaper",
        "documentStatus": "ready",
        "chunkType": "text",
        "patternName": null,
        "section": "A Human-Centric Venture Studio Entity Exploring …",
        "estimatedTokens": 794,
        "contentPreview": "A Human-Centric …", // first 240 chars
        "embeddingModel": "voyage-3",
        "embeddingProvider": "voyage",
        "embeddedAt": "2026-05-10T22:00:00.000Z",
        "x": 1.234, // UMAP-projected
        "y": -0.567, // UMAP-projected
      },
    ],
    "stats": {
      "totalEmbedded": 38,
      "returned": 38,
      "truncated": false,
      "droppedMalformed": 0, // rows whose pgvector text couldn't be parsed
      "projectable": true, // false if `returned < minUsefulPoints`
      "maxChunks": 2000,
      "minUsefulPoints": 10, // below this, UMAP can't produce a meaningful layout
    },
  },
}
```

**Edge cases.** Below `minUsefulPoints` (10) chunks, the route returns the chunks with `x: 0, y: 0` and `stats.projectable: false` — UMAP is skipped because the percentile of one or two adjacent-distance pairs is meaningless. Reads the pgvector column via raw SQL (the `Unsupported("vector(1536)")` Prisma type can't be selected via the typed client). Malformed vector rows are dropped defensively, logged with `logger.warn`, and counted in `stats.droppedMalformed` — one bad row never blocks the rest of the projection.

**Auth:** `withAdminAuth` + `adminLimiter` (UMAP compute is non-trivial — a request per few seconds is fine, hammering it isn't).

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
  "voiceInputGloballyEnabled": true,
}
```

At least one top-level field must be present. Every model id is validated against the in-memory registry — unknown ids return `400`. `globalMonthlyBudgetUsd` must be `null`, `0`, or a positive number ≤ 1,000,000.

`voiceInputGloballyEnabled` is the org-wide kill switch for the voice-input feature (default `true`). When `false`, every agent's `enableVoiceInput` flag is treated as off regardless of its own value: the mic surface disappears from admin chat / embed widgets and the transcribe endpoints reject with `VOICE_DISABLED`. Use this for incident response or compliance pause without editing each agent.

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

**Synchronous POST**, not SSE. Runs an AI analysis of the session logs, scores every `ai_response` log against three named metrics (faithfulness, groundedness, relevance), updates the session to `completed`, and logs cost rows with `operation: 'evaluation'`.

- Logs are capped at **50** events for the analysis prompt and the scoring loop.
- Summary call: bounded at `temperature: 0.2`, `maxTokens: 1500`, `10 000 ms` timeout.
- Scoring call: independent judge model, configured via `EVALUATION_JUDGE_PROVIDER` / `EVALUATION_JUDGE_MODEL` (default to `EVALUATION_DEFAULT_PROVIDER` / `EVALUATION_DEFAULT_MODEL`, which default to `anthropic` / `claude-sonnet-4-6`).
- Deleted agent (`agentId: null`) → summary call falls back to `EVALUATION_DEFAULT_*`.
- Malformed JSON from the summary or judge → one retry with a stricter prompt. Second failure on the summary → sanitized `500`; second failure on the judge for a single log → that log is skipped (logged at warn) and the loop continues. **Raw LLM output is never forwarded.**
- Per-log judge errors are swallowed at warn — `metricSummary.scoredLogCount` reflects the successful subset.
- Wholesale scoring failure (e.g. judge provider unavailable) leaves the session `completed` with `metricSummary: null`.
- Two `AiCostLog` rows per completion: `metadata: { phase: 'summary' }` and `metadata: { phase: 'scoring', logsScored: N }`.
- See [`../orchestration/evaluation-metrics.md`](../orchestration/evaluation-metrics.md) for the rubric, persistence shape, and noisy-scores caveat below ~20 messages.

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
      "metricSummary": {
        "avgFaithfulness": 0.92,
        "avgGroundedness": 0.85,
        "avgRelevance": 0.95,
        "scoredLogCount": 4,
        "judgeProvider": "anthropic",
        "judgeModel": "claude-sonnet-4-6",
        "scoredAt": "2026-05-03T16:00:00.000Z",
        "totalScoringCostUsd": 0.012,
      },
    },
  },
}
```

`metricSummary` is `null` when scoring failed wholesale or the session had no `ai_response` logs.

Error mapping:

| Status | When                                        |
| ------ | ------------------------------------------- |
| 404    | Session missing or cross-user               |
| 409    | Session already `completed`                 |
| 400    | Session has no logs                         |
| 500    | Sanitized — raw provider/LLM errors dropped |
| 429    | Rate limit (`adminLimiter`)                 |

### `POST /evaluations/:id/rescore`

Re-runs the named-metric scorer over an already-completed session. Useful after a knowledge-base update, prompt tweak, or judge-model swap.

- Gated on `status === 'completed'` — non-completed → `409 ConflictError`.
- Per-log scores overwrite in place; `metricSummary.scoredAt` advances; `totalScoringCostUsd` accumulates across runs.
- Same per-log error swallowing as `/complete` — one bad turn doesn't void the pass.
- Synchronous POST. Response shape: `{ session: { sessionId, metricSummary } }` — no summary regeneration.
- Rate-limited (`adminLimiter`).

Error mapping mirrors `/complete` except `409` here means "not completed yet" (rather than "already completed"):

| Status | When                                                                  |
| ------ | --------------------------------------------------------------------- |
| 404    | Session missing or cross-user                                         |
| 409    | Session is not `completed` (only completed sessions can be re-scored) |
| 400    | Session has no logs                                                   |
| 500    | Sanitized — raw provider/LLM errors dropped                           |
| 429    | Rate limit (`adminLimiter`)                                           |

### `GET /agents/:id/evaluation-trend`

Returns one trend point per completed evaluation session for the agent, scoped to the caller's user, sorted by `completedAt` ascending. Powers the per-agent quality chart on `/admin/orchestration/agents/[id]`.

```jsonc
{
  "success": true,
  "data": {
    "points": [
      {
        "sessionId": "cmj...",
        "title": "Q1 sample",
        "completedAt": "2026-04-15T10:00:00.000Z",
        "avgFaithfulness": 0.92,
        "avgGroundedness": 0.85,
        "avgRelevance": 0.95,
        "scoredLogCount": 5,
      },
    ],
  },
}
```

Sessions whose `metricSummary` is `null` (scoring failed wholesale) are excluded. Returns an empty `points` array when the agent has no completed scored sessions.

| Status | When          |
| ------ | ------------- |
| 404    | Agent missing |
| 400    | Invalid CUID  |

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

Create a webhook subscription. Body: `{ url: string, secret: string, events: string[], description?: string, isActive?: boolean }`. Secret is required (min 16 chars). Returns `201` with the created subscription (secret is never returned in responses).

### `GET / PATCH / DELETE /webhooks/:id`

Standard CRUD for a single webhook subscription. Scoped to `session.user.id` — cross-user returns 404. `PATCH` body: `{ url?, secret?, events?, description?, isActive? }`. `DELETE` is a hard delete.

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

## Embed Endpoints

Public (non-admin) routes for the embeddable chat widget. Base path: `/api/v1/embed`.

### GET `/embed/widget.js`

Serves a self-contained JavaScript snippet that renders a Shadow DOM chat bubble. Configured via data attributes (`data-token`, `data-position`, `data-theme`). No authentication required — the token is validated when the user sends a message.

**Response:** `application/javascript`, `Cache-Control: public, max-age=300`, `Access-Control-Allow-Origin: *`.

**Key file:** `app/api/v1/embed/widget.js/route.ts`

### POST `/embed/chat/stream`

SSE streaming chat for the embed widget. Authenticates via `X-Embed-Token` header (not session). CORS headers are set dynamically from the token's `allowedOrigins`.

**Request headers:** `X-Embed-Token: <token>` (required), `Content-Type: application/json`.

**Request body:**

```jsonc
{
  "message": "string (1–10000 chars, required)",
  "conversationId": "string (optional — continue existing conversation)",
}
```

**Response:** `text/event-stream` (SSE) — same event types as admin chat stream (see `ChatEvent` in `types/orchestration.ts`).

**Rate limiting:** `embedChatLimiter` per IP.

**Key files:** `app/api/v1/embed/chat/stream/route.ts`, `lib/embed/auth.ts`

---

## Related

- [`.context/orchestration/admin-api.md`](../orchestration/admin-api.md) — Architecture + design rationale
- [`.context/orchestration/chat.md`](../orchestration/chat.md) — Streaming chat handler internals
- [`.context/orchestration/knowledge.md`](../orchestration/knowledge.md) — Knowledge base library API
- [`.context/orchestration/workflows.md`](../orchestration/workflows.md) — DAG validator + Phase 5.2 roadmap
- [`.context/api/sse.md`](./sse.md) — The `sseResponse` bridge helper consumed by `/chat/stream`
- `lib/validations/orchestration.ts` — All Zod schemas referenced above
- `types/orchestration.ts` — `ChatEvent`, `CostSummary`, `EvaluationStatus`, etc.
