# Event Hooks

In-process event dispatch for orchestration lifecycle events. Admins configure hooks that fire on events like `workflow.completed` or `message.created`, routing them to an outbound webhook URL.

> **Source of truth:** `lib/orchestration/hooks/`. Update this doc when those files change.

## Hooks vs. Webhook Subscriptions

These are two different subsystems — don't confuse them:

| System                     | Model                                         | Purpose                                                      | Signing                                 | Retry                     |
| -------------------------- | --------------------------------------------- | ------------------------------------------------------------ | --------------------------------------- | ------------------------- |
| **Event Hooks** (this doc) | `AiEventHook` / `AiEventHookDelivery`         | Lightweight fire-and-forget dispatch on lifecycle events     | **None** — plain POST with user headers | 3 attempts (10s/60s/300s) |
| Webhook Subscriptions      | `AiWebhookSubscription` / `AiWebhookDelivery` | Durable outbound notifications with per-delivery audit trail | HMAC-SHA256 via `secret` field          | 3 attempts (10s/60s/300s) |

If you need HMAC signing, use the webhook subscriptions subsystem — see [Webhook Management UI](../admin/orchestration-webhooks.md).

## Module Layout

```
lib/orchestration/hooks/
├── registry.ts   # emitHookEvent, invalidateHookCache
└── types.ts      # HOOK_EVENT_TYPES, HookAction, HookFilter, HookEventPayload
```

## Data Model

`AiEventHook` — stored in `ai_event_hook`:

| Field       | Type         | Notes                                            |
| ----------- | ------------ | ------------------------------------------------ |
| `id`        | CUID         | Primary key                                      |
| `name`      | String       | Human label (max 200)                            |
| `eventType` | VarChar(100) | One of `HOOK_EVENT_TYPES` (indexed)              |
| `action`    | JSON         | `{ type: 'webhook', url, headers? }`             |
| `filter`    | JSON?        | Optional — equality-match keys on `payload.data` |
| `isEnabled` | Boolean      | Indexed. Only enabled hooks load into the cache. |
| `createdBy` | FK → User    |                                                  |

## Event Types

Defined in `HOOK_EVENT_TYPES` in `lib/orchestration/hooks/types.ts`:

| Event Type             | Currently Emitted By                                  |
| ---------------------- | ----------------------------------------------------- |
| `workflow.started`     | `lib/orchestration/engine/orchestration-engine.ts`    |
| `workflow.completed`   | `lib/orchestration/engine/orchestration-engine.ts`    |
| `workflow.failed`      | `lib/orchestration/engine/orchestration-engine.ts`    |
| `message.created`      | `lib/orchestration/chat/streaming-handler.ts`         |
| `conversation.started` | `lib/orchestration/chat/streaming-handler.ts`         |
| `agent.updated`        | `app/api/v1/admin/orchestration/agents/[id]/route.ts` |

## Event Payload

```ts
interface HookEventPayload {
  eventType: HookEventType;
  timestamp: string; // ISO-8601
  data: Record<string, unknown>; // event-specific shape
}
```

The `data` shape is not validated or typed per event — callers of `emitHookEvent()` decide what to include.

## Filter Syntax

`HookFilter` is a flat object of equality checks against `payload.data`:

```json
{ "agentSlug": "support-bot" }
```

Semantics (see `matchesFilter` in `registry.ts`):

- `null`/absent filter → match everything
- Each key must match `payload.data[key]` exactly (`===`)
- `undefined` / `null` filter values are skipped (treated as wildcards)
- No operators, globs, nested paths, or arrays — just strict equality on top-level keys

## Emitting Events

```ts
import { emitHookEvent } from '@/lib/orchestration/hooks/registry';

emitHookEvent('workflow.completed', {
  workflowId: wf.id,
  executionId: exec.id,
  agentSlug: agent.slug,
});
```

`emitHookEvent` is **fire-and-forget**. It returns `void` immediately and swallows all dispatch errors with a `logger.warn`. Callers never await hook dispatch.

## Webhook Action

```ts
// Action JSON on the hook row
{
  "type": "webhook",
  "url": "https://example.com/hook",
  "headers": { "X-Custom": "value" }
}
```

Dispatch behaviour (`dispatchWebhook`):

- Creates an `AiEventHookDelivery` record per dispatch (status `pending` → `delivered` / `failed` / `exhausted`)
- `POST` with `Content-Type: application/json`, `X-Hook-Event: <eventType>`, plus any user-supplied headers
- Body is the full `HookEventPayload`
- 10-second timeout via `AbortSignal.timeout(10_000)`
- **No HMAC signing** — use webhook subscriptions for signed delivery
- On non-2xx / network error: updates the delivery row with `lastResponseCode` / `lastError` and schedules an in-process retry (up to 3 attempts at 10s / 60s / 300s). If the process restarts mid-backoff, `processPendingHookRetries()` picks stale rows up on the next maintenance tick.
- URLs are SSRF-validated via `isSafeProviderUrl` in the Zod schema on create/update (blocks RFC1918, metadata endpoints, etc.)

## Cache Behaviour

- Enabled hooks load from the DB into a module-level `Map<eventType, CachedHook[]>`
- **TTL:** 60 seconds (`CACHE_TTL_MS`)
- Any hook CRUD operation (POST, PATCH, DELETE) calls `invalidateHookCache()` so admin changes take effect immediately
- The cache is per-process — in a multi-instance deployment each instance independently reloads within 60s of a change

## Admin API

All routes require admin auth (`withAdminAuth`). Mutations are rate-limited via `adminLimiter`.

| Method   | Path                                                     | Description                                                  |
| -------- | -------------------------------------------------------- | ------------------------------------------------------------ |
| `GET`    | `/api/v1/admin/orchestration/hooks`                      | Paginated list (`?page`, `?limit`, `?eventType`)             |
| `POST`   | `/api/v1/admin/orchestration/hooks`                      | Create a hook                                                |
| `GET`    | `/api/v1/admin/orchestration/hooks/:id`                  | Fetch one hook                                               |
| `PATCH`  | `/api/v1/admin/orchestration/hooks/:id`                  | Update (all fields optional)                                 |
| `DELETE` | `/api/v1/admin/orchestration/hooks/:id`                  | Hard delete                                                  |
| `GET`    | `/api/v1/admin/orchestration/hooks/:id/deliveries`       | Paginated delivery history (`?page`, `?pageSize`, `?status`) |
| `POST`   | `/api/v1/admin/orchestration/hooks/deliveries/:id/retry` | Manually re-dispatch a `failed` / `exhausted` delivery       |

Validation: `createHookSchema` / `updateHookSchema` in the route files enforce `action.type === 'webhook'`. Webhook URLs pass through `isSafeProviderUrl`; the `id` path param must be a CUID.

### Deliveries

Every dispatch attempt creates an `AiEventHookDelivery` row (see [Webhook Action](#webhook-action) above for the lifecycle). The two delivery routes make that history queryable:

- **List** (`GET /hooks/:id/deliveries`) — ordered by `createdAt desc`. The `?status` filter accepts `pending`, `delivered`, `failed`, or `exhausted`. Returns 404 if the parent hook doesn't exist.
- **Retry** (`POST /hooks/deliveries/:id/retry`) — calls `retryHookDelivery()`, which resets `attempts` to 0 and re-dispatches. Only retriable deliveries (`failed` / `exhausted`) are accepted; `pending` / `delivered` rows return 404 with "no longer retriable".

## Related Docs

- [Webhook Management UI](../admin/orchestration-webhooks.md) — the separate HMAC-signed outbound webhook subsystem
- [Resilience](./resilience.md) — error-handling patterns across orchestration
- [Orchestration Admin API](./admin-api.md) — full admin HTTP surface
