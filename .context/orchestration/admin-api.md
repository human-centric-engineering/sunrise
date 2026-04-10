# Agent Orchestration — Admin API

Admin-only HTTP surface for managing agents, capabilities, and their relationships. Every capability here is the entry point the admin dashboard will wrap — build against these endpoints with `curl` first.

**Auth:** All routes require the `ADMIN` role via `withAdminAuth` (`lib/auth/guards.ts`). Non-admins get 403, unauthenticated callers get 401.

**Rate limiting:** Every mutating handler (POST / PATCH / DELETE) is gated by `adminLimiter` (30 req/min, `lib/security/rate-limit.ts`), keyed by `getClientIP(request)`. GET routes are unlimited per house convention.

**Response envelope:** Standard `{ success, data }` / `{ success, error }` shape from `lib/api/responses.ts`. Mutating endpoints throw typed errors (`NotFoundError`, `ConflictError`, `ValidationError`) which `withAdminAuth` funnels through `handleAPIError`.

## Quick Reference

| Endpoint                                                      | Methods            | Purpose                                           |
| ------------------------------------------------------------- | ------------------ | ------------------------------------------------- |
| `/api/v1/admin/orchestration/agents`                          | GET, POST          | List / create agents                              |
| `/api/v1/admin/orchestration/agents/:id`                      | GET, PATCH, DELETE | Read / update / soft-delete an agent              |
| `/api/v1/admin/orchestration/agents/:id/capabilities`         | POST               | Attach a capability to an agent                   |
| `/api/v1/admin/orchestration/agents/:id/capabilities/:capId`  | PATCH, DELETE      | Toggle / reconfigure / detach the pivot row       |
| `/api/v1/admin/orchestration/agents/:id/instructions-history` | GET                | Read the full `systemInstructions` audit trail    |
| `/api/v1/admin/orchestration/agents/:id/instructions-revert`  | POST               | Revert to a previous `systemInstructions` version |
| `/api/v1/admin/orchestration/agents/export`                   | POST               | Export selected agents as a versioned bundle      |
| `/api/v1/admin/orchestration/agents/import`                   | POST               | Import an agent bundle (skip / overwrite)         |
| `/api/v1/admin/orchestration/capabilities`                    | GET, POST          | List / create capabilities                        |
| `/api/v1/admin/orchestration/capabilities/:id`                | GET, PATCH, DELETE | Read / update / soft-delete a capability          |
| `/api/v1/admin/orchestration/providers`                       | GET, POST          | List / create LLM provider configs                |
| `/api/v1/admin/orchestration/providers/:id`                   | GET, PATCH, DELETE | Read / update / soft-delete a provider config     |
| `/api/v1/admin/orchestration/providers/:id/test`              | POST               | Run a live connection test against a provider     |
| `/api/v1/admin/orchestration/providers/:id/models`            | GET                | Ask the provider directly what models it exposes  |
| `/api/v1/admin/orchestration/models`                          | GET                | Aggregated model registry (all providers)         |
| `/api/v1/admin/orchestration/workflows`                       | GET, POST          | List / create workflows                           |
| `/api/v1/admin/orchestration/workflows/:id`                   | GET, PATCH, DELETE | Read / update / soft-delete a workflow            |
| `/api/v1/admin/orchestration/workflows/:id/validate`          | POST               | DAG validation of the stored `workflowDefinition` |
| `/api/v1/admin/orchestration/workflows/:id/execute`           | POST               | Run a workflow _(501 — stub, Session 5.2)_        |
| `/api/v1/admin/orchestration/executions/:id`                  | GET                | Read an execution _(501 — stub, Session 5.2)_     |
| `/api/v1/admin/orchestration/executions/:id/approve`          | POST               | Approve a paused execution _(501 — stub, 5.2)_    |

Validation schemas for every payload live in `lib/validations/orchestration.ts`.

## Agents

### List agents

```
GET /api/v1/admin/orchestration/agents?page=1&limit=20&isActive=true&provider=anthropic&q=support
```

Filters: `isActive` (coerced bool), `provider` (exact match), `q` (case-insensitive `OR` across `name` / `slug` / `description`). Response uses `paginatedResponse` — `{ success, data, meta: { page, limit, total, totalPages } }`.

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
    "history": [{ "instructions": "...", "changedAt": "...", "changedBy": "..." }]
  }
}
```

`history` is returned **newest first** for UI convenience. The underlying JSON column is stored oldest→newest — that's the ordering `versionIndex` refers to in the revert endpoint. Malformed rows log a warning and return `history: []` rather than failing.

### Revert

```bash
curl -X POST /api/v1/admin/orchestration/agents/<id>/instructions-revert \
  -d '{ "versionIndex": 0 }'
```

Validated by `instructionsRevertSchema`. `versionIndex` is an index into the stored (oldest-first) array. The route:

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

CRUD over `AiWorkflow`, plus a pure-logic DAG `/validate` endpoint. The workflow **executor** lands in Phase 5 (Session 5.2) — the three execute / read / approve routes ship this session as 501 stubs (see _Executions (stubbed)_ below).

### List / create / read / update / delete

```bash
curl '/api/v1/admin/orchestration/workflows?isActive=true&isTemplate=false&q=onboarding'
```

Filters: `isActive`, `isTemplate`, `q` (matches `name` / `slug` / `description`). Paginated.

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

The validator is reused verbatim by `POST /workflows/:id/execute` (as a pre-flight check before the engine call) and will be reused by the Session 5.2 engine itself.

## Executions (stubbed)

`POST /workflows/:id/execute`, `GET /executions/:id`, and `POST /executions/:id/approve` ship this session as **501 stubs**. The `OrchestrationEngine` arrives in Phase 5 (Session 5.2). Each stub is a **full route handler** — auth, rate limit, Zod validation, DB lookup — and returns `errorResponse` at the exact line the engine will plug into.

Why stubs rather than a minimal engine: building a throwaway executor now would either create two code paths that drift, or lock us into implementation decisions 5.2 is better placed to make. The stubs lock the route **contract** (shape, auth, errors) so Phase 4 UI work can build against them today.

### What the stubs validate

Clients can exercise everything short of the engine itself:

| Stub route                     | Validates                                                                                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /workflows/:id/execute`  | Admin auth · rate limit · `executeWorkflowBodySchema` (`inputData` required, optional `budgetLimitUsd`) · CUID · workflow exists (404) · workflow `isActive` (400) · `validateWorkflow` pre-flight (400 with DAG errors)            |
| `GET /executions/:id`          | Admin auth · CUID · execution exists (404)                                                                                                                                                                                          |
| `POST /executions/:id/approve` | Admin auth · rate limit · `approveExecutionBodySchema` (optional `approvalPayload`, optional `notes`) · CUID · execution exists (404). Deliberately does **not** check `execution.status` — state transitions are the engine's job. |

### 501 response shape

All three stubs return:

```json
{
  "success": false,
  "error": {
    "code": "NOT_IMPLEMENTED",
    "message": "Workflow execution engine arrives in Phase 5 (Session 5.2)"
  }
}
```

HTTP status: `501`. Each route also logs `log.warn('... stubbed — 501', { ... })` so the stub is visible in production logs if anyone deploys a client against it prematurely.

### The Session 5.2 swap

Each stub carries a `// TODO(Session 5.2):` comment marking the exact line the engine plugs into. The 5.2 change per route is a single-line replacement:

```typescript
// workflows/:id/execute
return successResponse(
  await engine.execute({
    workflow,
    inputData: body.inputData,
    budgetLimitUsd: body.budgetLimitUsd,
    userId: session.user.id,
  })
);

// executions/:id
return successResponse(execution);

// executions/:id/approve
return successResponse(await engine.resumeApproval(id, session.user.id, body.approvalPayload));
```

Everything above that line — auth, validation, lookups — stays as-is.

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

## Related

- [`overview.md`](./overview.md) — Orchestration module layout and architecture decisions
- [`workflows.md`](./workflows.md) — DAG validator, step shapes, error codes, Phase 5.2 roadmap
- [`llm-providers.md`](./llm-providers.md) — Provider abstraction, cost tracking, model registry
- [`capabilities.md`](./capabilities.md) — Dispatcher internals, built-in capabilities, rate limiting
- [`chat.md`](./chat.md) — Streaming chat handler and tool loop
- [`../api/admin-endpoints.md`](../api/admin-endpoints.md) — Other admin API endpoints
- `lib/validations/orchestration.ts` — All Zod schemas referenced above
- `prisma/schema.prisma:145-220` — `AiAgent`, `AiCapability`, `AiAgentCapability` models
