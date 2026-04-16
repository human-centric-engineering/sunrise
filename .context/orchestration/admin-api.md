# Agent Orchestration — Admin API

Admin-only HTTP surface for managing agents, capabilities, and their relationships. Every capability here is the entry point the admin dashboard will wrap — build against these endpoints with `curl` first.

**Auth:** All routes require the `ADMIN` role via `withAdminAuth` (`lib/auth/guards.ts`). Non-admins get 403, unauthenticated callers get 401.

**Rate limiting:** Every mutating handler (POST / PATCH / DELETE) is gated by `adminLimiter` (30 req/min, `lib/security/rate-limit.ts`), keyed by `getClientIP(request)`. GET routes are unlimited per house convention.

**Response envelope:** Standard `{ success, data }` / `{ success, error }` shape from `lib/api/responses.ts`. Mutating endpoints throw typed errors (`NotFoundError`, `ConflictError`, `ValidationError`) which `withAdminAuth` funnels through `handleAPIError`.

## Quick Reference

| Endpoint                                                      | Methods            | Purpose                                              |
| ------------------------------------------------------------- | ------------------ | ---------------------------------------------------- |
| `/api/v1/admin/orchestration/agents`                          | GET, POST          | List / create agents                                 |
| `/api/v1/admin/orchestration/agents/:id`                      | GET, PATCH, DELETE | Read / update / soft-delete an agent                 |
| `/api/v1/admin/orchestration/agents/:id/capabilities`         | GET, POST          | List attached pivots / attach a capability           |
| `/api/v1/admin/orchestration/agents/:id/capabilities/:capId`  | PATCH, DELETE      | Toggle / reconfigure / detach the pivot row          |
| `/api/v1/admin/orchestration/agents/:id/instructions-history` | GET                | Read the full `systemInstructions` audit trail       |
| `/api/v1/admin/orchestration/agents/:id/instructions-revert`  | POST               | Revert to a previous `systemInstructions` version    |
| `/api/v1/admin/orchestration/agents/export`                   | POST               | Export selected agents as a versioned bundle         |
| `/api/v1/admin/orchestration/agents/import`                   | POST               | Import an agent bundle (skip / overwrite)            |
| `/api/v1/admin/orchestration/capabilities`                    | GET, POST          | List / create capabilities                           |
| `/api/v1/admin/orchestration/capabilities/:id`                | GET, PATCH, DELETE | Read / update / soft-delete a capability             |
| `/api/v1/admin/orchestration/capabilities/:id/agents`         | GET                | Reverse-lookup — agents attaching this capability    |
| `/api/v1/admin/orchestration/providers`                       | GET, POST          | List / create LLM provider configs                   |
| `/api/v1/admin/orchestration/providers/:id`                   | GET, PATCH, DELETE | Read / update / soft-delete a provider config        |
| `/api/v1/admin/orchestration/providers/:id/test`              | POST               | Run a live connection test against a provider        |
| `/api/v1/admin/orchestration/providers/:id/models`            | GET                | Ask the provider directly what models it exposes     |
| `/api/v1/admin/orchestration/models`                          | GET                | Aggregated model registry (all providers)            |
| `/api/v1/admin/orchestration/workflows`                       | GET, POST          | List / create workflows                              |
| `/api/v1/admin/orchestration/workflows/:id`                   | GET, PATCH, DELETE | Read / update / soft-delete a workflow               |
| `/api/v1/admin/orchestration/workflows/:id/validate`          | POST               | DAG validation of the stored `workflowDefinition`    |
| `/api/v1/admin/orchestration/workflows/:id/execute`           | POST               | Run a workflow — SSE `text/event-stream`             |
| `/api/v1/admin/orchestration/executions/:id`                  | GET                | Read an execution row + parsed trace                 |
| `/api/v1/admin/orchestration/executions/:id/approve`          | POST               | Approve a `paused_for_approval` execution            |
| `/api/v1/admin/orchestration/chat/stream`                     | POST               | Streaming chat turn (SSE `text/event-stream`)        |
| `/api/v1/admin/orchestration/knowledge/search`                | POST               | Hybrid vector + keyword search over chunks           |
| `/api/v1/admin/orchestration/knowledge/patterns/:number`      | GET                | Fetch all chunks for a single design pattern         |
| `/api/v1/admin/orchestration/knowledge/documents`             | GET, POST          | List documents / upload a new one (multipart)        |
| `/api/v1/admin/orchestration/knowledge/documents/:id`         | GET, DELETE        | Read / delete a document (chunks cascade)            |
| `/api/v1/admin/orchestration/knowledge/documents/:id/rechunk` | POST               | Re-run chunking + embedding on an existing doc       |
| `/api/v1/admin/orchestration/knowledge/seed`                  | POST               | Seed the canonical "Agentic Design Patterns" doc     |
| `/api/v1/admin/orchestration/conversations`                   | GET                | List the caller's own conversations                  |
| `/api/v1/admin/orchestration/conversations/:id`               | DELETE             | Delete one of the caller's conversations             |
| `/api/v1/admin/orchestration/conversations/:id/messages`      | GET                | Read messages for one of the caller's conversations  |
| `/api/v1/admin/orchestration/conversations/clear`             | POST               | Bulk-delete the caller's conversations by filter     |
| `/api/v1/admin/orchestration/costs`                           | GET                | Cost breakdown by day / agent / model                |
| `/api/v1/admin/orchestration/costs/summary`                   | GET                | Today / week / month totals, per-agent, per-model    |
| `/api/v1/admin/orchestration/costs/alerts`                    | GET                | Agents at or above 80% of their monthly budget       |
| `/api/v1/admin/orchestration/settings`                        | GET, PATCH         | Singleton: model defaults, global cap, search config |
| `/api/v1/admin/orchestration/agents/:id/budget`               | GET                | Read-only budget status (use PATCH agent to mutate)  |
| `/api/v1/admin/orchestration/evaluations`                     | GET, POST          | List the caller's evaluation sessions / create one   |
| `/api/v1/admin/orchestration/evaluations/:id`                 | GET, PATCH         | Read / update an evaluation session                  |
| `/api/v1/admin/orchestration/evaluations/:id/logs`            | GET                | Read log events for one of the caller's sessions     |
| `/api/v1/admin/orchestration/evaluations/:id/complete`        | POST               | Run the AI analysis pass and flip to `completed`     |

Validation schemas for every payload live in `lib/validations/orchestration.ts`.

## Agents

### List agents

```
GET /api/v1/admin/orchestration/agents?page=1&limit=20&isActive=true&provider=anthropic&q=support
```

Filters: `isActive` (coerced bool), `provider` (exact match), `q` (case-insensitive `OR` across `name` / `slug` / `description`). Response uses `paginatedResponse` — `{ success, data, meta: { page, limit, total, totalPages } }`. Each item includes `_count: { capabilities, conversations }` and `_budget: BudgetSummary | null` (batch-computed via `groupBy` — not per-row). Types: `AiAgentListItem` in `types/orchestration.ts`.

### Create agent

```bash
curl -X POST /api/v1/admin/orchestration/agents \
  -H 'Content-Type: application/json' \
  -d '{
    "name": "Support Bot",
    "slug": "support-bot",
    "description": "Answers customer questions",
    "systemInstructions": "You are a helpful support assistant.",
    "model": "claude-sonnet-4-6",
    "provider": "anthropic"
  }'
```

Validated by `createAgentSchema`. New agents start with `systemInstructionsHistory: []` and `createdBy = session.user.id`. Slug collision → 409 `ConflictError`.

### Update agent — `systemInstructions` audit push

```bash
curl -X PATCH /api/v1/admin/orchestration/agents/<id> \
  -d '{ "systemInstructions": "You are a friendlier support assistant." }'
```

All `updateAgentSchema` fields are optional and applied conditionally. The **only** fiddly behaviour is the history push:

- When `body.systemInstructions !== undefined && body.systemInstructions !== current.systemInstructions`, the route pushes the _previous_ value onto `systemInstructionsHistory`:
  ```json
  { "instructions": "<old value>", "changedAt": "<ISO>", "changedBy": "<admin user id>" }
  ```
- If `systemInstructionsHistory` is malformed in the DB, it's logged via `logger.warn` and reset to `[]` before the push. Nothing explodes.
- Updates that don't change `systemInstructions` never touch the history column.

### Delete agent

`DELETE /api/v1/admin/orchestration/agents/:id` is a **soft delete** (`isActive = false`). `AiAgent` has FKs from `AiConversation`, `AiMessage`, `AiCostLog`, and `AiEvaluationSession`; a hard delete would either cascade audit data or fail. If you really need a hard delete, use Prisma Studio.

## Agent ↔ Capability pivot

### List attached capabilities

```
GET /api/v1/admin/orchestration/agents/:id/capabilities
```

Returns every `AiAgentCapability` pivot row for the agent with the related `AiCapability` eagerly loaded (ordered by `capability.name asc`). 404 when the agent doesn't exist. Admin-auth gated, rate-limited. This is the endpoint the agent edit page's Capabilities tab reads to populate the "Attached" column — see [`../admin/agent-form.md`](../admin/agent-form.md).

### Attach a capability

```bash
curl -X POST /api/v1/admin/orchestration/agents/<agentId>/capabilities \
  -d '{
    "capabilityId": "<cuid>",
    "isEnabled": true,
    "customConfig": { "maxResults": 5 },
    "customRateLimit": 30
  }'
```

Creates an `AiAgentCapability` row. Validates that both the agent and capability exist. `P2002` (already attached) → 409. On success the route calls `capabilityDispatcher.clearCache()` so the dispatcher picks up the new binding on its next dispatch.

### Update or detach

`PATCH` and `DELETE` on `/agents/:id/capabilities/:capId` both use the compound key `(agentId, capabilityId)` — **`capId` is the `AiCapability.id`**, not the pivot row id, which keeps URLs predictable and matches the attach body.

- `PATCH` body: `{ isEnabled?, customConfig?, customRateLimit? }` (`updateAgentCapabilitySchema`).
- `DELETE` returns `{ agentId, capabilityId, detached: true }`.
- `P2025` (link not found) → 404.
- Both call `capabilityDispatcher.clearCache()` on success.

## Instructions history & revert

### Read history

```
GET /api/v1/admin/orchestration/agents/:id/instructions-history
```

Response:

```json
{
  "success": true,
  "data": {
    "agentId": "<cuid>",
    "slug": "support-bot",
    "current": "You are a helpful support assistant.",
    "history": [
      { "instructions": "...", "changedAt": "...", "changedBy": "...", "versionIndex": 2 }
    ]
  }
}
```

`history` is returned **newest first** for UI convenience, but each entry carries an explicit `versionIndex` field that points at the **raw oldest→newest DB position** — i.e. the exact value the `/instructions-revert` endpoint expects. Clients should pass `history[n].versionIndex` straight through rather than the array position `n`, otherwise the newest-first display order would silently invert the target version. Malformed rows log a warning and return `history: []` rather than failing.

### Revert

```bash
curl -X POST /api/v1/admin/orchestration/agents/<id>/instructions-revert \
  -d '{ "versionIndex": 0 }'
```

Validated by `instructionsRevertSchema`. `versionIndex` is an index into the stored (oldest-first) array — always pass the `versionIndex` carried on the GET response entry, not the array position of the entry in the newest-first list. The route:

1. Fetches the agent.
2. Parses history via `systemInstructionsHistorySchema.safeParse`. Malformed history → 400 `ValidationError` ("cannot revert").
3. Validates `versionIndex < history.length` → 400 if out of range.
4. Pushes the **current** `systemInstructions` onto history with a new timestamp / `changedBy` entry — so the value you're reverting _from_ is recoverable.
5. Writes the target version into `systemInstructions` and the grown history back to the column in a single Prisma `update`.

Without step 4, an accidental revert would be permanent. Don't remove it.

## Export / import

Bundles are versioned (`version: '1'`) and strip server-owned fields (`id`, `createdAt`, `updatedAt`, `createdBy`). Capabilities are embedded by **slug**, not by id, so bundles are portable across environments.

### Export

```bash
curl -X POST /api/v1/admin/orchestration/agents/export \
  -d '{ "agentIds": ["<cuid>", "<cuid>"] }' \
  -o bundle.json
```

Validated by `exportAgentsSchema` (1–100 ids). Any missing id → 404. Response shape:

```json
{
  "success": true,
  "data": {
    "version": "1",
    "exportedAt": "2026-04-10T12:00:00.000Z",
    "agents": [
      {
        "name": "Support Bot",
        "slug": "support-bot",
        "description": "...",
        "systemInstructions": "...",
        "systemInstructionsHistory": [],
        "model": "claude-sonnet-4-6",
        "provider": "anthropic",
        "providerConfig": null,
        "temperature": 0.7,
        "maxTokens": 4096,
        "monthlyBudgetUsd": null,
        "metadata": null,
        "isActive": true,
        "capabilities": [
          { "slug": "search-web", "isEnabled": true, "customConfig": null, "customRateLimit": null }
        ]
      }
    ]
  }
}
```

The response also sets `Content-Disposition: attachment; filename="agents-export-<ISO>.json"` so hitting the route from a browser triggers a Save As dialog.

### Import

```bash
curl -X POST /api/v1/admin/orchestration/agents/import \
  -d '{ "bundle": { ... }, "conflictMode": "skip" }'
```

Validated by `importAgentsSchema`. `conflictMode` defaults to `'skip'` — the safer default for accidental re-imports. Per agent:

| State                    | `skip`                        | `overwrite`                                                |
| ------------------------ | ----------------------------- | ---------------------------------------------------------- |
| Slug exists in target DB | Increment `results.skipped`   | Update the row in place, `deleteMany` + rebuild pivot rows |
| Slug does not exist      | Create the agent + pivot rows | Create the agent + pivot rows                              |

Capability slugs that don't exist in the target environment are collected into `results.warnings[]` rather than failing the whole import — bundles frequently come from superset environments. The entire import runs inside a single `prisma.$transaction`, so any failure rolls the whole operation back. `capabilityDispatcher.clearCache()` is called once at the very end.

Response:

```json
{
  "success": true,
  "data": {
    "imported": 2,
    "overwritten": 0,
    "skipped": 1,
    "warnings": ["Agent 'support-bot': capability 'legacy-tool' not found — skipped"]
  }
}
```

## Capabilities

Mirrors the agent endpoints. `createCapabilitySchema` validates everything including the `functionDefinition` (OpenAI function schema). `POST`, `PATCH`, and `DELETE` all call `capabilityDispatcher.clearCache()` so the dispatcher re-reads the registry on its next dispatch.

```bash
# List
curl '/api/v1/admin/orchestration/capabilities?category=web&executionType=internal'

# Create
curl -X POST /api/v1/admin/orchestration/capabilities \
  -d '{
    "name": "Web Search",
    "slug": "web-search",
    "description": "Search the web via DuckDuckGo",
    "category": "web",
    "functionDefinition": { "name": "web_search", "parameters": {} },
    "executionType": "internal",
    "executionHandler": "WebSearchCapability"
  }'

# Soft delete (returns { id, isActive: false })
curl -X DELETE /api/v1/admin/orchestration/capabilities/<id>
```

Slug collisions on create → 409 `ConflictError`. On PATCH slug collisions → 400 `ValidationError` with `{ slug: ['Slug is already in use'] }`.

### Reverse-lookup: agents using a capability

```
GET /api/v1/admin/orchestration/capabilities/:id/agents
```

Returns the minimal agent projection for every agent that currently attaches this capability via the `AiAgentCapability` pivot — `[{ id, name, slug, isActive }]`, ordered by agent name. Empty array if nothing attached; 404 on unknown id; 400 on invalid CUID. Mirrors the additive `/agents/:id/capabilities` exception taken in Session 4.2.

Consumers:

- **Capabilities list page** — `_agents` array is now returned inline on each capability from `GET /capabilities`, so the list page no longer makes per-row requests. This endpoint is still used by the edit page.
- **Capability edit page** — the Safety tab's "Used by N agents" card, and the delete confirmation dialog (so admins see exactly who breaks when they soft-delete).

## Providers

CRUD over `AiProviderConfig`, plus a live connection test and a per-provider model listing.

### API-key safety (hard guarantee)

`AiProviderConfig` stores only `apiKeyEnvVar` — the **name** of the environment variable, never the key itself. Every GET / POST / PATCH response hydrates rows with:

```json
{ "apiKeyEnvVar": "ANTHROPIC_API_KEY", "apiKeyPresent": true }
```

`apiKeyPresent` is derived from `typeof process.env[apiKeyEnvVar] === 'string' && length > 0` inside `isApiKeyEnvVarSet()` in `lib/orchestration/llm/provider-manager.ts`. The env var **value** is never read into a response, returned from a route, or written to a log. This is covered by the "never exposes env var value" assertion in `tests/integration/api/v1/admin/orchestration/providers.id.test.ts`.

### SSRF safety (hard guarantee)

`AiProviderConfig.baseUrl` is an admin-settable outbound HTTP target — without guardrails a malicious admin could point it at AWS IMDS (`169.254.169.254`), an RFC1918 host, or an internal service and use the live `/test` + `/models` routes as a blind-SSRF oracle. Three layers defend against this:

1. **Schema validation** — `providerConfigSchema` and `updateProviderConfigSchema` both `.superRefine()` through `checkSafeProviderUrl()` in `lib/security/safe-url.ts`. Rejects non-`http(s)` schemes, cloud metadata hosts (AWS / GCP / Azure / Alibaba), `0.0.0.0` / `[::]`, RFC1918 (`10/8`, `172.16/12`, `192.168/16`), CGNAT (`100.64/10`), link-local (`169.254/16`, `fe80::/10`), IPv6 unique-local (`fc00::/7`), and loopback unless the row is marked `isLocal: true`.
2. **Build-time re-check** — `buildProviderFromConfig()` in `provider-manager.ts` calls the same validator before passing `baseUrl` to `OpenAiCompatibleProvider`. Throws `ProviderError({ code: 'unsafe_base_url' })` on reject. Catches PATCH merges where `isLocal` was flipped without `baseUrl` being re-sent, plus any direct DB writes that bypass Zod (seed scripts, migrations, manual SQL).
3. **Error-oracle suppression** — `/providers/:id/test` and `/providers/:id/models` never forward raw SDK error messages to the client. The test route returns a flat `{ ok: false, models: [], error: 'connection_failed' }`; the models route returns a generic `"Provider X is unavailable"` at 503. The actual SDK error is logged server-side via `log.warn()` only. Without this, a bad-baseUrl attacker could distinguish ECONNREFUSED vs. TLS failure vs. 404 and use that as a port-scanning signal.

Loopback is only permitted when the provider row explicitly sets `isLocal: true` — this is how "local" provider rows pointing at Ollama / LM Studio / vLLM on the same box work. Even with `isLocal: true`, private / link-local / metadata ranges remain blocked; local model servers run on loopback, not on the LAN.

No DNS resolution happens at validate-time — defending against DNS rebinding would require pinning the resolved IP through the subsequent fetch, which the OpenAI / Anthropic SDKs don't expose. The build-time re-check is still run on every `getProvider()` miss, which narrows the rebinding window. See the module comment at the top of `lib/security/safe-url.ts` for full details.

### List / create

```bash
curl '/api/v1/admin/orchestration/providers?isActive=true&providerType=anthropic&q=claude'
```

Filters: `isActive` (coerced bool), `providerType` (`anthropic` / `openai-compatible`), `isLocal` (coerced bool), `q` (case-insensitive match on `name` / `slug`). Response is paginated; each row carries `apiKeyPresent`.

```bash
curl -X POST /api/v1/admin/orchestration/providers \
  -d '{
    "name": "Anthropic",
    "slug": "anthropic",
    "providerType": "anthropic",
    "apiKeyEnvVar": "ANTHROPIC_API_KEY",
    "isActive": true
  }'
```

Validated by `providerConfigSchema`. `apiKeyEnvVar` must match `/^[A-Z][A-Z0-9_]*$/`. `slug` or `name` conflict → 409 `ConflictError`. Successful writes call `providerManager.clearCache()` so the next `getProvider()` rebuilds the instance.

### Read / update / delete

`GET /providers/:id` hydrates `apiKeyPresent`. `PATCH` uses `updateProviderConfigSchema` (all fields optional, `apiKeyEnvVar` and `baseUrl` nullable). On slug change the route clears the cache for **both** the old and new slug so no stale instance lingers. `DELETE` is a **soft delete** (`isActive = false`) and clears the cache for that slug.

### Test connection

```bash
curl -X POST /api/v1/admin/orchestration/providers/<id>/test
```

Rate-limited. Loads the provider row, calls `providerManager.testProvider(slug)`, returns:

```json
{ "success": true, "data": { "ok": true, "models": ["claude-sonnet-4-6", "..."] } }
```

`{ ok: false }` is returned with **HTTP 200** — the endpoint itself succeeded; the provider just failed. Only 404 / 401 / 403 / 5xx indicate the endpoint itself broke. A thrown `ProviderError` is caught and surfaced in `{ ok: false, error }` at 200.

### List models (per provider)

```bash
curl /api/v1/admin/orchestration/providers/<id>/models
```

Calls `getProvider(slug).listModels()` live — this is "what does _this_ provider say it has", distinct from the aggregated registry below. Failures return 503 via a typed error so callers can differentiate transient provider outages from 404s.

### Aggregated model registry

```bash
curl /api/v1/admin/orchestration/models
curl '/api/v1/admin/orchestration/models?refresh=true'
```

Returns `{ models, refreshed }` from `modelRegistry.getAvailableModels()` — the merged view across static fallback + OpenRouter. `?refresh=true` calls `refreshFromOpenRouter({ force: true })` first and **rate-limits the refresh path only**. The plain GET is unrate-limited per house convention.

## Workflows

CRUD over `AiWorkflow`, plus a pure-logic DAG `/validate` endpoint and a live SSE `/execute` path. The runtime engine is documented in [`engine.md`](./engine.md); execution HTTP contracts are in [Executions](#executions) below.

### List / create / read / update / delete

```bash
curl '/api/v1/admin/orchestration/workflows?isActive=true&isTemplate=false&q=onboarding'
```

Filters: `isActive`, `isTemplate`, `q` (matches `name` / `slug` / `description`). Paginated. Each item includes `_count: { executions: number }`. Types: `AiWorkflowListItem` in `types/orchestration.ts`.

```bash
curl -X POST /api/v1/admin/orchestration/workflows \
  -d '{
    "name": "Research Pipeline",
    "slug": "research-pipeline",
    "description": "Multi-step research workflow",
    "workflowDefinition": {
      "entryStepId": "start",
      "errorStrategy": "fail",
      "steps": [
        { "id": "start", "name": "Start", "type": "llm_call", "config": {}, "nextSteps": [] }
      ]
    }
  }'
```

Validated by `createWorkflowSchema`. `PATCH` re-runs `updateWorkflowSchema` over provided fields — including the Zod validation of `workflowDefinition` — so a malformed update never slips in. `DELETE` is a **soft delete**.

### Validate DAG structure

```bash
curl -X POST /api/v1/admin/orchestration/workflows/<id>/validate
```

Empty body. Runs `validateWorkflow(workflow.workflowDefinition)` from `lib/orchestration/workflows`. Response:

```json
{
  "success": true,
  "data": {
    "ok": false,
    "errors": [
      {
        "code": "UNKNOWN_TARGET",
        "stepId": "a",
        "message": "Step 'a' references unknown target 'ghost'"
      },
      { "code": "CYCLE_DETECTED", "path": ["a", "b", "a"], "message": "Cycle detected: a → b → a" }
    ]
  }
}
```

Errors are **typed by `code`**, never just message strings — clients and the future workflow-editor UI should render them structurally. Every `code`, its meaning, and the validator's algorithm are documented in [`workflows.md`](./workflows.md).

The validator is reused verbatim by `POST /workflows/:id/execute` as a pre-flight check before the engine call, and again by the engine's defence-in-depth pass on the stored definition.

## Executions

Three admin routes drive the runtime engine. The engine implementation lives in `lib/orchestration/engine/` — see [`engine.md`](./engine.md) for the event model, executor registry, context lifecycle, and error strategies. This section is the **HTTP contract**.

**Ownership scoping.** Every route is scoped to `session.user.id`. A cross-user lookup on `GET /executions/:id` or `POST /executions/:id/approve` returns **404**, not 403 — we do not confirm existence of rows outside the caller's own history. The same rule applies when resuming via `?resumeFromExecutionId=` on `/execute`.

### Execute workflow (SSE)

```bash
curl -N -X POST /api/v1/admin/orchestration/workflows/<id>/execute \
  -H 'Content-Type: application/json' \
  -d '{
    "inputData": { "query": "Summarise the ReAct pattern" },
    "budgetLimitUsd": 0.5
  }'
```

Validated by `executeWorkflowBodySchema` (`inputData` required, optional `budgetLimitUsd`). The route:

1. Runs admin auth + rate limit.
2. Loads the workflow, rejects with **404** when missing, **400 VALIDATION_ERROR** when `isActive === false`.
3. Runs `validateWorkflow()` pre-flight on the stored definition — structural errors surface as `400` with the full DAG error list on `error.details`.
4. Optionally resolves `?resumeFromExecutionId=<cuid>` — if the target row exists but belongs to another user, **404** (never 403).
5. Instantiates `OrchestrationEngine`, hands the resulting `AsyncIterable<ExecutionEvent>` straight to [`sseResponse`](../api/sse.md), and returns the `text/event-stream` response.

Each frame is a discriminated `ExecutionEvent` — `workflow_started`, `step_started`, `step_completed`, `step_failed`, `approval_required`, `budget_warning`, `workflow_completed`, `workflow_failed`. See [`engine.md`](./engine.md#executionevent-sse-payloads) for the full union and [`../api/sse.md`](../api/sse.md) for the framing contract and error sanitization guarantee (raw executor errors never reach the wire).

The client's `AbortController.abort()` is forwarded to the engine via `request.signal`; aborting mid-stream leaves the `AiWorkflowExecution` row at its last checkpoint.

### Read execution detail

```bash
curl /api/v1/admin/orchestration/executions/<id>
```

No body. Returns the row plus a parsed `ExecutionTraceEntry[]`:

```json
{
  "success": true,
  "data": {
    "execution": {
      "id": "<cuid>",
      "workflowId": "<cuid>",
      "status": "running",
      "currentStep": "step2",
      "totalTokensUsed": 2400,
      "totalCostUsd": 0.012,
      "budgetLimitUsd": 0.5,
      "startedAt": "2026-04-11T12:00:00.000Z",
      "completedAt": null
    },
    "trace": [
      {
        "stepId": "step1",
        "stepType": "llm_call",
        "label": "Generate",
        "status": "completed",
        "output": "...",
        "tokensUsed": 1200,
        "costUsd": 0.006,
        "startedAt": "2026-04-11T12:00:00.000Z",
        "completedAt": "2026-04-11T12:00:01.200Z",
        "durationMs": 1200
      }
    ]
  }
}
```

Cross-user → **404**. Malformed CUID → **400 VALIDATION_ERROR**.

### Approve paused execution

```bash
curl -X POST /api/v1/admin/orchestration/executions/<id>/approve \
  -H 'Content-Type: application/json' \
  -d '{
    "approvalPayload": { "decision": "approved", "reviewer": "alice" },
    "notes": "LGTM"
  }'
```

Validated by `approveExecutionBodySchema` (`approvalPayload` optional object, `notes` optional string ≤ 5000 chars). The route:

1. Auth + rate limit + CUID + ownership check (cross-user → **404**).
2. Rejects with **400** if `execution.status !== 'paused_for_approval'`.
3. Flips the row's `status` from `paused_for_approval` → `running`, persists `approvalPayload` onto the awaiting step's trace entry (marking it `status: 'completed'` with `approvalPayload` merged into its `output`), and returns:

```json
{
  "success": true,
  "data": { "success": true, "resumeStepId": "<stepId>" }
}
```

The client is then expected to reconnect via `POST /workflows/:id/execute?resumeFromExecutionId=<id>` to drain the remaining events. This keeps the engine stateless between HTTP boundaries.

## Chat (streaming)

One SSE endpoint that pipes `StreamingChatHandler` through the `lib/api/sse.ts` bridge. The first SSE route in the repo.

### Endpoint

```
POST /api/v1/admin/orchestration/chat/stream
Content-Type: application/json
```

Request body validated by `chatStreamRequestSchema`:

```json
{
  "message": "Explain the ReAct pattern",
  "agentSlug": "pattern-coach",
  "conversationId": "<cuid, optional>",
  "contextType": "pattern",
  "contextId": "1",
  "entityContext": { "optional": "record" }
}
```

- `message` — required, 1–50_000 chars, trimmed
- `agentSlug` — required, slug of an **active** `AiAgent`
- `conversationId` — optional. Omit to start a new conversation; supply to continue one. Mismatched `userId`/`agentId`/`isActive` → terminal `conversation_not_found` error event.
- `contextType` + `contextId` — optional locked-context pair. Only `pattern` is loaded today.
- `entityContext` — opaque, passed through to capability handlers

### Response

`200 OK` with headers:

```
Content-Type: text/event-stream; charset=utf-8
Cache-Control: no-cache, no-transform
Connection: keep-alive
X-Accel-Buffering: no
```

The body is a sequence of SSE frames. Each frame:

```
event: <ChatEvent.type>
data: <full ChatEvent JSON>

```

### ChatEvent types

From `types/orchestration.ts:191-197`:

| Type                | Payload shape                   | When                                                                                      |
| ------------------- | ------------------------------- | ----------------------------------------------------------------------------------------- |
| `start`             | `{ conversationId, messageId }` | Once, after the user message is persisted                                                 |
| `content`           | `{ delta }`                     | Zero or more. Incremental assistant text — concatenate for the full message               |
| `status`            | `{ message }`                   | Before dispatching a tool call (e.g. `"Executing search_knowledge_base"`)                 |
| `capability_result` | `{ capabilitySlug, result }`    | After the capability dispatcher resolves a tool call. `result` may carry `success: false` |
| `done`              | `{ tokenUsage, costUsd }`       | Terminal. Final turn's usage and cost only — per-turn cost logs are persisted out-of-band |
| `error`             | `{ code, message }`             | Terminal alternative. Stable `code` values listed in [`chat.md`](./chat.md#error-codes)   |

Every turn yields exactly one terminal event (`done` or `error`) — consumers should loop until they see one and then close the reader.

### Error-frame sanitization (hard guarantee)

The chat route never forwards raw error strings to the client. **Two** layers enforce this:

1. **Domain layer** — `lib/orchestration/chat/streaming-handler.ts` catches any thrown exception in its outer try and yields `{ type: 'error', code: 'internal_error', message: 'An unexpected error occurred' }`. The detailed error is logged via `logger.error` server-side only. This catches Prisma internals, provider SDK error text, internal hostnames, and stack-trace fragments before they reach the iterator boundary.
2. **Transport layer** — `sseResponse` in `lib/api/sse.ts` has its own last-resort catch. If the iterator itself throws (a bug in the handler, not a domain error), it emits one sanitized terminal frame:

   ```
   event: error
   data: {"type":"error","code":"stream_error","message":"Stream terminated unexpectedly"}
   ```

   and closes. Again, the raw `err.message` is **never** forwarded.

See [`../api/sse.md`](../api/sse.md) for the full bridge contract.

### AbortSignal and client disconnect

`request.signal` is wired into both the chat handler and the SSE bridge. When the client disconnects:

1. Next.js aborts `request.signal`
2. `sseResponse`'s abort listener stops the keepalive timer and closes the stream controller
3. The chat handler's in-flight `provider.chatStream` call is aborted via the same signal
4. No further frames are emitted; no orphan DB writes happen beyond the fire-and-forget cost log that was already in flight

### Keepalive

Every 15 s (default) the bridge emits `: keepalive\n\n` — an SSE comment frame ignored by `EventSource` but enough to keep reverse proxies from timing out an idle stream during long tool calls.

### Example — `curl -N`

```bash
curl -N -X POST http://localhost:3000/api/v1/admin/orchestration/chat/stream \
  -H 'Content-Type: application/json' \
  -b cookies.txt \
  -d '{"message":"Explain the ReAct pattern","agentSlug":"pattern-coach","contextType":"pattern","contextId":"1"}'
```

`-N` disables curl's output buffering so frames print as they arrive.

### Example — browser JS client

```typescript
const res = await fetch('/api/v1/admin/orchestration/chat/stream', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ message, agentSlug, conversationId }),
  signal: abortController.signal,
});

const reader = res.body!.getReader();
const decoder = new TextDecoder();
let buffer = '';

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });

  // Split complete frames on the double-newline terminator
  const frames = buffer.split('\n\n');
  buffer = frames.pop() ?? '';
  for (const frame of frames) {
    const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
    if (!dataLine) continue;
    const event = JSON.parse(dataLine.slice(6));
    handleChatEvent(event); // your switch on event.type
  }
}
```

Prefer this over `EventSource` — `EventSource` doesn't support POST bodies, custom headers, or `AbortController`.

## Knowledge Base

Six routes wrapping `documentManager`, `searchKnowledge`, `getPatternDetail`, and `seedFromChunksJson`. See [`knowledge.md`](./knowledge.md) for the underlying library API and document lifecycle.

### Search

```bash
curl -X POST /api/v1/admin/orchestration/knowledge/search \
  -H 'Content-Type: application/json' \
  -d '{
    "query": "chain of thought reasoning",
    "filters": { "chunkType": "pattern_overview" },
    "limit": 10
  }'
```

POST (not GET) — the filter payload can contain arbitrary text and we don't want search queries in URL logs. Rate-limited via `adminLimiter`. Validated by `knowledgeSearchSchema` (existing). Returns `{ results: [...] }`.

### Pattern detail

```bash
curl /api/v1/admin/orchestration/knowledge/patterns/1
```

Path param validated by `getPatternParamSchema` (`number` coerced positive integer). Delegates to `getPatternDetail(number)`. Returns 404 `NotFoundError` when no chunks exist for that pattern number. Non-numeric path segments → 400.

### List / upload documents

```bash
# List
curl '/api/v1/admin/orchestration/knowledge/documents?page=1&limit=20&status=ready&q=react'
```

`GET` paginates via `listDocumentsQuerySchema`. Filters: `status` (`pending` / `processing` / `ready` / `failed`), `q` (substring match on title, case-insensitive). Each row includes `_count.chunks`.

```bash
# Upload — MULTIPART, not JSON
curl -X POST /api/v1/admin/orchestration/knowledge/documents \
  -F 'file=@react-patterns.md'
```

**Multipart upload contract (load-bearing):**

- **Field name:** `file` (form field)
- **Max size:** 10 MB (`MAX_UPLOAD_BYTES = 10 * 1024 * 1024` in the route)
- **Allowed extensions:** `.md`, `.markdown`, `.txt` — text only this session. PDF / HTML are future work
- **MIME type:** advisory only. The extension check is the source of truth — browsers frequently omit `Content-Type` for `.md` files
- **Unknown file field / missing file / wrong type** → 400 `ValidationError`
- **Returns** 201 with `{ document: { id, title, status, ... } }`

Uploaded documents are parsed synchronously via `documentManager.uploadDocument`, which handles chunking and embedding in-process.

### Read / delete a document

```bash
curl /api/v1/admin/orchestration/knowledge/documents/<id>                 # GET — 404 if missing
curl -X DELETE /api/v1/admin/orchestration/knowledge/documents/<id>       # DELETE — cascades chunks
```

Knowledge documents are **not per-user scoped** — any admin can read or delete any document. `uploadedBy` is stored for audit only.

### Rechunk

```bash
curl -X POST /api/v1/admin/orchestration/knowledge/documents/<id>/rechunk
```

Empty body. Re-runs the chunker + embedder on an existing document — use it after improving `chunker.ts` or fixing a classification bug. 404 if the document is missing; **409 `ConflictError`** if the document is currently `status === 'processing'` (guards against double-rechunk races).

### Seed

```bash
curl -X POST /api/v1/admin/orchestration/knowledge/seed
```

Empty body. Resolves `path.join(process.cwd(), 'prisma/seeds/data/chunks/chunks.json')` and calls `seedFromChunksJson`. **Idempotent** — if the "Agentic Design Patterns" document already exists, the seeder is a no-op. Safe to call on every deploy. Returns `{ seeded: true }`.

## Conversations

Four routes over `AiConversation` / `AiMessage`. **Every endpoint is scoped to `session.user.id`.**

### Ownership model (read this)

> **Loud warning:** Admins using these endpoints see only **their own** conversations. There is no cross-user admin audit view in this session — that would be a separate endpoint with its own auth model and audit logging (deliberately out of scope).
>
> **Cross-user access returns 404, not 403.** We do not confirm the existence of resources owned by another user. Every mutating route does the ownership check via `findFirst({ where: { id, userId: session.user.id } })` — a null result becomes `NotFoundError`. Don't "helpfully" switch this to 403: the information leak is the whole point 404 is avoiding.
>
> Every conversation route contains the literal `userId: session.user.id` pattern. This is enforced by a pre-PR grep check.

### List conversations

```bash
curl '/api/v1/admin/orchestration/conversations?page=1&limit=20&agentId=<cuid>&isActive=true&q=support'
```

Validated by `listConversationsQuerySchema`. Filters: `agentId` (CUID), `isActive` (coerced bool), `q` (case-insensitive `contains` on `title`). Response includes `_count.messages`. Always scoped to `userId: session.user.id` — the filter is non-negotiable.

### Read messages

```bash
curl /api/v1/admin/orchestration/conversations/<id>/messages
```

First runs the ownership check (`findFirst` with `userId`), then `aiMessage.findMany` ordered by `createdAt asc`. Cross-user id → 404. Malformed id → 400. No rate limit (GET).

### Delete one conversation

```bash
curl -X DELETE /api/v1/admin/orchestration/conversations/<id>
```

Rate-limited. Ownership check as above, then `prisma.aiConversation.delete({ where: { id } })`. `AiMessage` cascades via the existing FK relation. Returns `{ deleted: true }`.

### Clear conversations (bulk)

```bash
curl -X POST /api/v1/admin/orchestration/conversations/clear \
  -H 'Content-Type: application/json' \
  -d '{ "olderThan": "2025-01-01T00:00:00Z" }'
```

**This is the single most dangerous endpoint in the orchestration admin surface.** Validated by `clearConversationsBodySchema`, which uses a Zod `.refine()` to **require at least one of `olderThan` or `agentId`**:

- **Empty body → 400.** This is deliberate. An empty-body "delete everything" call is a common tooling mistake; the schema makes it impossible.
- `{ olderThan }` — deletes the caller's conversations with `createdAt < olderThan`
- `{ agentId }` — deletes the caller's conversations bound to that agent
- Both — AND-combined

The `WHERE` clause is hardcoded to `{ userId: session.user.id, ...filters }` — `userId` is never an input. Cross-user bulk delete is impossible through this endpoint by construction. Returns `{ deletedCount }`. `AiMessage` rows cascade.

## Costs

Admin-global observability over `AiCostLog`. Unlike every other user-scoped endpoint in this document, **cost endpoints are not scoped to the caller** — `AiCostLog` has no `userId` relation; it's a system-wide ledger. Every admin sees the same totals. This mirrors the knowledge base design.

Validation schemas for the cost surface live in `lib/validations/orchestration.ts` (`costBreakdownQuerySchema`). Aggregation logic lives in `lib/orchestration/llm/cost-reports.ts` — a platform-agnostic query module sitting alongside the existing `cost-tracker.ts`. No new Prisma migration was introduced; `AiCostLog` and `AiAgent.monthlyBudgetUsd` already existed from Phase 2a.

### Cost breakdown

```bash
curl '/api/v1/admin/orchestration/costs?dateFrom=2026-03-01&dateTo=2026-04-01&groupBy=day'
curl '/api/v1/admin/orchestration/costs?dateFrom=2026-03-01&dateTo=2026-04-01&groupBy=agent'
curl '/api/v1/admin/orchestration/costs?dateFrom=2026-03-01&dateTo=2026-04-01&groupBy=model&agentId=<cuid>'
```

Query params (validated by `costBreakdownQuerySchema`):

| Field      | Type                    | Notes                                        |
| ---------- | ----------------------- | -------------------------------------------- |
| `agentId`  | CUID (optional)         | Restrict the aggregation to a single agent   |
| `dateFrom` | ISO date                | Inclusive, interpreted at UTC midnight       |
| `dateTo`   | ISO date                | Inclusive, interpreted for the whole UTC day |
| `groupBy`  | `day \| agent \| model` | Required                                     |

**Hard guards:**

- `dateTo` must be on or after `dateFrom` (schema refine).
- Date span must be ≤ **366 days** (schema refine). Wider windows would unbounded-scan `AiCostLog` — the limit exists to keep the query bounded, not to match a calendar.
- `groupBy=day` runs a Postgres-native `date_trunc('day', "createdAt")` via `$queryRawUnsafe`. `agent` and `model` use `prisma.aiCostLog.groupBy`; `agent` does a single follow-up `aiAgent.findMany({ where: { id: { in: [...] } } })` to resolve names (no N+1).
- Agents that have been deleted still show up under a `(deleted)` key when rows point at `agentId: null`.

Response envelope:

```json
{
  "success": true,
  "data": {
    "groupBy": "day",
    "rows": [
      {
        "key": "2026-03-01",
        "totalCostUsd": 1.5,
        "inputTokens": 1000,
        "outputTokens": 500,
        "count": 3
      }
    ],
    "totals": { "totalCostUsd": 1.5, "inputTokens": 1000, "outputTokens": 500, "count": 3 }
  }
}
```

Rows from `groupBy=agent` / `groupBy=model` also carry a `label` (agent name / model id) and are sorted by `totalCostUsd` descending. Rows from `groupBy=day` are sorted ascending.

### Cost summary

```bash
curl /api/v1/admin/orchestration/costs/summary
```

No query params. Dashboard-friendly aggregation computed by `getCostSummary()` with all sub-queries running in parallel:

- `totals.today` — rolling UTC day (`[todayStart, tomorrowStart)`)
- `totals.week` — rolling 7 UTC days ending at next UTC midnight
- `totals.month` — current UTC calendar month, matching `checkBudget`'s convention
- `byAgent` — month-to-date spend per agent, sorted by spend desc, with `utilisation = monthSpend / monthlyBudgetUsd`. Agents without a budget return `utilisation: null`. Agents that were deleted (no row in `aiAgent`) drop out entirely.
- `byModel` — month-to-date spend per model id, sorted desc
- `trend` — 30 UTC days of daily totals in ascending order. Days with no spend are omitted.

### Budget alerts

```bash
curl /api/v1/admin/orchestration/costs/alerts
```

Returns every agent with a `monthlyBudgetUsd` where `spent / budget >= 0.8`, classified by severity:

| Utilisation | Severity   |
| ----------- | ---------- |
| `< 0.8`     | _omitted_  |
| `0.8..<1.0` | `warning`  |
| `>= 1.0`    | `critical` |

Agents without a budget, and agents with `monthlyBudgetUsd <= 0`, are filtered out unconditionally. Sorted by utilisation desc.

```json
{
  "success": true,
  "data": {
    "alerts": [
      {
        "agentId": "cmj...",
        "name": "Support Bot",
        "slug": "support-bot",
        "monthlyBudgetUsd": 100,
        "spent": 92.34,
        "utilisation": 0.9234,
        "severity": "warning"
      }
    ]
  }
}
```

### Agent budget status

```bash
curl /api/v1/admin/orchestration/agents/<id>/budget
```

Read-only convenience over `checkBudget()` from `lib/orchestration/llm/cost-tracker.ts`. Returns the existing `BudgetStatus` shape:

```json
{
  "success": true,
  "data": {
    "withinBudget": true,
    "spent": 42.17,
    "limit": 100,
    "remaining": 57.83
  }
}
```

Agents with no `monthlyBudgetUsd` return `{ withinBudget: true, spent, limit: null, remaining: null }`. Malformed `id` → 400. Missing agent → 404 (the handler catches the `Error('Agent ... not found')` thrown by `checkBudget` and rethrows as `NotFoundError`).

**This endpoint is read-only by design.** Budget mutations go through `PATCH /api/v1/admin/orchestration/agents/:id` via `updateAgentSchema.monthlyBudgetUsd`. A second mutation path would fork the audit trail, so there is deliberately no `PATCH /agents/:id/budget`.

## Evaluations

Evaluation sessions drive the "review an agent's performance" flow. Each session owns an ordered list of `AiEvaluationLog` rows (user inputs, AI responses, capability calls, results, errors) and transitions through `draft → in_progress → completed` or `draft → in_progress → archived`. The `/complete` endpoint is the only path that can set `status='completed'` — by design, `PATCH` cannot.

**Ownership:** every evaluation endpoint is scoped to `session.user.id`. Cross-user access returns **404, not 403** — matching the conversations convention. Do not "fix" this.

The handler layer lives in `lib/orchestration/evaluations/` — platform-agnostic, no `next/*` imports. Validation schemas live in `lib/validations/orchestration.ts` (`createEvaluationSchema`, `updateEvaluationSchema`, `listEvaluationsQuerySchema`, `evaluationLogsQuerySchema`, `completeEvaluationBodySchema`).

### List evaluations

```
GET /api/v1/admin/orchestration/evaluations?page=1&limit=20&agentId=<cuid>&status=in_progress&q=foo
```

Filters (`listEvaluationsQuerySchema`): `agentId`, `status` (`draft | in_progress | completed | archived`), and `q` (case-insensitive `title` contains). Every `where` clause hardcodes `userId: session.user.id`. Response includes `agent` (id/name/slug) and `_count.logs`.

### Create evaluation

```bash
curl -X POST /api/v1/admin/orchestration/evaluations \
  -H 'Content-Type: application/json' \
  -d '{
    "agentId": "<cuid>",
    "title": "Support bot tone review",
    "description": "Sample of Q1 support conversations",
    "metadata": { "sampleSize": 50 }
  }'
```

Validated by `createEvaluationSchema`. The route checks the agent exists (any admin can create a session against any agent — agents are shared) and creates the session in `status='draft'` with `userId = session.user.id`. Returns `201` with the created row.

### Read / update one evaluation

```bash
curl /api/v1/admin/orchestration/evaluations/<id>
curl -X PATCH /api/v1/admin/orchestration/evaluations/<id> \
  -d '{ "status": "in_progress", "description": "Expanded to 100 conversations" }'
```

Both methods run an ownership check via `findFirst({ where: { id, userId: session.user.id } })` and throw `NotFoundError` on miss. PATCH is rate-limited.

**PATCH deliberately cannot set `status='completed'`.** `updateEvaluationSchema.status` is an enum excluding `'completed'` — Zod rejects the value at the boundary. Completion must go through `/complete` so the AI analysis and the status flip happen atomically. The schema also uses a `.refine()` to reject empty update bodies.

### Read evaluation logs

```
GET /api/v1/admin/orchestration/evaluations/<id>/logs?limit=100&before=<sequenceNumber>
```

Cursor pagination — `limit` defaults to 100, hard-capped at 500. `before` is a positive integer `sequenceNumber`; rows are returned where `sequenceNumber < before`, ordered by `sequenceNumber` ascending. The cursor and the order are on the same key, so backward paging is exact (an earlier CUID-cursor implementation was replaced because CUID lexicographic order diverges from numeric sequence order). Ownership is checked on the parent session; cross-user → 404.

### Complete evaluation

```bash
curl -X POST /api/v1/admin/orchestration/evaluations/<id>/complete
```

**Synchronous POST**, not SSE. Runs in `completeEvaluationSession()` (`lib/orchestration/evaluations/complete-session.ts`):

1. Load the session `{ id, userId }` (include `agent`, `logs`) — missing → `NotFoundError`.
2. Reject if `status === 'completed'` → `ConflictError`.
3. Reject if `logs.length === 0` → `ValidationError('evaluation_has_no_logs')`.
4. Fetch up to **50** logs (`MAX_LOGS_IN_PROMPT`), ordered by `sequenceNumber` ascending. The cap bounds the analysis prompt; longer sessions are summarised from the first 50 events.
5. Resolve the provider via `getProvider(session.agent.provider)`. If the agent has been deleted (`session.agentId === null`), fall back to `process.env.EVALUATION_DEFAULT_PROVIDER ?? 'anthropic'` with `EVALUATION_DEFAULT_MODEL ?? 'claude-sonnet-4-6'`.
6. Issue a single non-streaming `provider.chat()` call capped at `temperature: 0.2`, `maxTokens: 1500`, and a `10_000 ms` `AbortSignal.timeout`.
7. Parse the response as `{ summary: string, improvementSuggestions: string[] }`. Code fences (` ```json `) are stripped. On malformed JSON, retry once with a stricter "respond only with JSON" prompt; on a second failure, throw a sanitized `Error('Failed to generate evaluation analysis')` — **the raw LLM output is never forwarded**.
8. Fire-and-forget `logCost({ operation: CostOperation.EVALUATION, ... })`. A Prisma failure here is logged but does not abort completion.
9. Update the session: `status='completed'`, `summary`, `improvementSuggestions`, `completedAt = new Date()`.

Response:

```json
{
  "success": true,
  "data": {
    "session": {
      "sessionId": "cmj...",
      "status": "completed",
      "summary": "...",
      "improvementSuggestions": ["...", "..."],
      "tokenUsage": { "input": 120, "output": 55 },
      "costUsd": 0
    }
  }
}
```

Error mapping:

| Thrown            | HTTP | When                                              |
| ----------------- | ---- | ------------------------------------------------- |
| `NotFoundError`   | 404  | Session missing or cross-user                     |
| `ConflictError`   | 409  | Session already `completed`                       |
| `ValidationError` | 400  | Session has no logs                               |
| Any other `Error` | 500  | Sanitized message — raw LLM/provider text dropped |

The route is rate-limited (`adminLimiter`) because completion is both a mutation and an LLM call — the most expensive endpoint in the evaluation surface.

## Smoke testing

The full admin HTTP surface has an end-to-end smoke script at `scripts/smoke/orchestration.ts`. It spins up an **in-process mock** OpenAI-compatible server (`/v1/chat/completions` JSON + SSE, `/v1/embeddings`, `/v1/models`), signs up a throwaway admin via better-auth, and drives ~32 assertions across:

- Providers CRUD + `/:id/test` connection
- Agents CRUD
- Capabilities CRUD + `/agents/:id/capabilities` pivot attach
- Workflows CRUD + `/validate` + `/execute` 501 stub
- `POST /chat/stream` — asserts `start` + terminal `done`/`error` frames
- Knowledge upload (mock `.md`) + chunk + embed + `POST /search`
- Evaluations create + log-seed + `/complete` (hits the mock LLM for the summary)
- Conversations list + `/clear` ownership scoping (empty body rejected, filter required)
- Costs breakdown / summary / alerts + `/agents/:id/budget`
- Direct Prisma re-query of `AiCostLog` to prove fire-and-forget cost writes persisted

All rows are scoped by a `smoke-test-orch-*` prefix and cleaned up at the end; the throwaway admin's `User` / `Session` / `Account` rows are also deleted. Run with:

```bash
npm run dev &            # dev server must be running
npm run smoke:orchestration
```

Successive runs inside the 60-second `adminLimiter` window may hit 429s — wait out the window or let the next run pre-flight poll. See [`scripts/smoke/README.md`](../../scripts/smoke/README.md) for the safety rules every smoke script must follow.

## Anti-patterns

- **Don't** call `capabilityDispatcher.dispatch()` from admin routes — the dispatcher is for the runtime chat loop, not CRUD. Only `clearCache()` belongs in this layer.
- **Don't** hand-roll auth checks — use `withAdminAuth` so rate limiting, request context, and error handling are consistent.
- **Don't** hard-delete agents or capabilities. Soft delete (`isActive = false`) preserves the audit trail the schema was designed for.
- **Don't** skip the `systemInstructionsHistory` push when updating `systemInstructions`. It's the only audit trail for prompt changes; the revert endpoint depends on it.
- **Don't** cast Prisma `Json` columns with `as` — parse via the relevant Zod schema and warn-and-skip on failure. See `systemInstructionsHistorySchema` usage in `agents/[id]/route.ts` and the history/revert routes for the pattern.
- **Don't** import from `next/*` inside `lib/orchestration/**`. Routes own the HTTP wrapping.
- **Don't** return or log `process.env[apiKeyEnvVar]` from any provider route. Only `apiKeyPresent: boolean` leaves the server. `provider-manager.ts` is the only module that reads the value, and it never emits it.
- **Don't** forward raw SDK / fetch error messages from `/providers/:id/test` or `/providers/:id/models`. They'd act as a blind-SSRF exfiltration oracle for the configured `baseUrl`. Return the generic `connection_failed` / `PROVIDER_UNAVAILABLE` responses those routes already use; log the real error server-side only.
- **Don't** skip `checkSafeProviderUrl` when adding new `baseUrl`-accepting fields or new provider types. The validator runs at both the schema and build-time layers for a reason — bypassing either lets admin input reach an outbound fetch unchecked.
- **Don't** flip the `501` stubs to `200` with mock data to unblock UI work. Phase 4 UI should build against real 501s until Session 5.2 lands — that's what locks the contract in place.
- **Don't** forward `err.message` from the chat stream route. The streaming-handler catch-all sanitizes to a generic message; the SSE bridge sanitizes again as defense-in-depth. If you need a richer error taxonomy, yield a typed `{ type: 'error', code, message }` from the source iterable — those pass through verbatim because they're not thrown.
- **Don't** return 403 on cross-user conversation access. It confirms the resource exists but belongs to someone else — information leak. Every ownership check must funnel through `NotFoundError` (404).
- **Don't** relax the `.refine()` on `clearConversationsBodySchema` to "make empty body convenient." An empty-body bulk delete is the exact accident the refine prevents.
- **Don't** add `application/json` document upload support without also adding a parallel security review. The multipart + extension-whitelist combo is the entire defence against uploading executable content disguised as markdown; a JSON `{ content, fileName }` endpoint would need its own content-type guards.
- **Don't** trust `file.type` (the MIME header) as a security boundary on upload. Browsers frequently omit it for `.md` files — the extension whitelist is the source of truth.

## Related

## Orchestration settings (singleton)

`AiOrchestrationSettings` is a single row (`slug: 'global'`) storing task-type model defaults, an optional cross-agent monthly budget cap, optional hybrid-search weight overrides, and the timestamp of the last knowledge-base seed. Lazily upserted on first read — the seeder deliberately does not touch most fields, so admin edits survive re-seeds (only `lastSeededAt` is updated by the seeder).

### GET /settings

```http
GET /api/v1/admin/orchestration/settings
```

Returns the hydrated singleton. Missing task keys are filled in from `computeDefaultModelMap()` so the response always has a complete `defaultModels` map even on first read.

```json
{
  "success": true,
  "data": {
    "id": "cmjbv4i3x00003wsloputgwu1",
    "slug": "global",
    "defaultModels": {
      "routing": "claude-haiku-4-5",
      "chat": "claude-sonnet-4-6",
      "reasoning": "claude-opus-4-6",
      "embeddings": "claude-haiku-4-5"
    },
    "globalMonthlyBudgetUsd": null,
    "searchConfig": null,
    "lastSeededAt": "2026-04-15T12:00:00.000Z",
    "createdAt": "2026-04-11T00:00:00.000Z",
    "updatedAt": "2026-04-11T00:00:00.000Z"
  }
}
```

### PATCH /settings

```http
PATCH /api/v1/admin/orchestration/settings
Content-Type: application/json

{ "defaultModels": { "routing": "claude-haiku-4-5" }, "globalMonthlyBudgetUsd": 500 }
```

Rate-limited by `adminLimiter`. Validated by `updateOrchestrationSettingsSchema`:

- `defaultModels` keys must be one of `routing | chat | reasoning | embeddings`
- Every model id must resolve via `getModel()` in the in-memory registry (`validateTaskDefaults()`)
- `globalMonthlyBudgetUsd` must be `null`, `0`, or a positive number ≤ 1,000,000
- `searchConfig` — optional object `{ keywordBoostWeight: number, vectorWeight: number }` or `null` to reset to defaults. `keywordBoostWeight` must be between -0.2 and 0 (non-positive, reduces cosine distance for keyword matches). `vectorWeight` must be between 0.1 and 2.0 (multiplier on vector similarity score).
- `lastSeededAt` — read-only, set automatically by the knowledge seeder; not accepted in PATCH
- At least one field must be present (empty PATCH rejected)

On success the handler calls `invalidateSettingsCache()` in `model-registry.ts` so the next chat turn picks up the new defaults immediately (otherwise the 30s TTL cache would delay the change).

### Enforcement

- `getDefaultModelForTask(task)` in `lib/orchestration/llm/model-registry.ts` resolves `task → model` through this row. Used by any orchestration code that needs "the default model for X" rather than an agent-specific override.
- `checkBudget()` in `lib/orchestration/llm/cost-tracker.ts` consults `globalMonthlyBudgetUsd` in addition to the per-agent cap. When the month-to-date cross-agent total meets or exceeds the cap it returns `{ withinBudget: false, globalCapExceeded: true }`, which the streaming chat handler translates into a `BUDGET_EXCEEDED_GLOBAL` error frame.

Failures in the global-cap lookup are swallowed and the code falls back to the per-agent path so a flaky Prisma read can't lock up chat globally.

- [`overview.md`](./overview.md) — Orchestration module layout and architecture decisions
- [`workflows.md`](./workflows.md) — DAG validator, step shapes, error codes, Phase 5.2 roadmap
- [`llm-providers.md`](./llm-providers.md) — Provider abstraction, cost tracking, model registry
- [`capabilities.md`](./capabilities.md) — Dispatcher internals, built-in capabilities, rate limiting
- [`chat.md`](./chat.md) — Streaming chat handler and tool loop
- [`knowledge.md`](./knowledge.md) — Knowledge base library API and document lifecycle
- [`../api/sse.md`](../api/sse.md) — `sseResponse` bridge helper contract
- [`../api/admin-endpoints.md`](../api/admin-endpoints.md) — Other admin API endpoints
- `lib/validations/orchestration.ts` — All Zod schemas referenced above
- `prisma/schema.prisma` — `AiAgent`, `AiCapability`, `AiAgentCapability`, `AiConversation`, `AiMessage`, `AiKnowledgeDocument`, `AiKnowledgeChunk` models
