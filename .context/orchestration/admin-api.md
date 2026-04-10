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

## Anti-patterns

- **Don't** call `capabilityDispatcher.dispatch()` from admin routes — the dispatcher is for the runtime chat loop, not CRUD. Only `clearCache()` belongs in this layer.
- **Don't** hand-roll auth checks — use `withAdminAuth` so rate limiting, request context, and error handling are consistent.
- **Don't** hard-delete agents or capabilities. Soft delete (`isActive = false`) preserves the audit trail the schema was designed for.
- **Don't** skip the `systemInstructionsHistory` push when updating `systemInstructions`. It's the only audit trail for prompt changes; the revert endpoint depends on it.
- **Don't** cast Prisma `Json` columns with `as` — parse via the relevant Zod schema and warn-and-skip on failure. See `systemInstructionsHistorySchema` usage in `agents/[id]/route.ts` and the history/revert routes for the pattern.
- **Don't** import from `next/*` inside `lib/orchestration/**`. Routes own the HTTP wrapping.

## Related

- [`overview.md`](./overview.md) — Orchestration module layout and architecture decisions
- [`capabilities.md`](./capabilities.md) — Dispatcher internals, built-in capabilities, rate limiting
- [`chat.md`](./chat.md) — Streaming chat handler and tool loop
- [`../api/admin-endpoints.md`](../api/admin-endpoints.md) — Other admin API endpoints
- `lib/validations/orchestration.ts` — All Zod schemas referenced above
- `prisma/schema.prisma:145-220` — `AiAgent`, `AiCapability`, `AiAgentCapability` models
