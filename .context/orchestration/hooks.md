# Event Hooks

In-process event dispatch for orchestration lifecycle events. Admins configure hooks that fire on events like `workflow.completed` or `message.created`, routing them to either an outbound webhook URL or a registered in-process handler.

> **Source of truth:** `lib/orchestration/hooks/`. Update this doc when those files change.

## Hooks vs. Webhook Subscriptions

These are two different subsystems — don't confuse them:

| System                     | Model                                         | Purpose                                                      | Signing                                 | Retry                            |
| -------------------------- | --------------------------------------------- | ------------------------------------------------------------ | --------------------------------------- | -------------------------------- |
| **Event Hooks** (this doc) | `AiEventHook`                                 | Lightweight fire-and-forget dispatch on lifecycle events     | **None** — plain POST with user headers | **None**                         |
| Webhook Subscriptions      | `AiWebhookSubscription` / `AiWebhookDelivery` | Durable outbound notifications with per-delivery audit trail | HMAC-SHA256 via `secret` field          | Retry queue via maintenance tick |

If you need HMAC signing or guaranteed delivery, use the webhook subscriptions subsystem — see [Webhook Management UI](../admin/orchestration-webhooks.md).

## Module Layout

```
lib/orchestration/hooks/
├── registry.ts   # emitHookEvent, registerInternalHandler, invalidateHookCache
└── types.ts      # HOOK_EVENT_TYPES, HookAction, HookFilter, HookEventPayload
```

## Data Model

`AiEventHook` — stored in `ai_event_hook`:

| Field       | Type         | Notes                                                                   |
| ----------- | ------------ | ----------------------------------------------------------------------- |
| `id`        | CUID         | Primary key                                                             |
| `name`      | String       | Human label (max 200)                                                   |
| `eventType` | VarChar(100) | One of `HOOK_EVENT_TYPES` (indexed)                                     |
| `action`    | JSON         | `{ type: 'webhook', url, headers? }` or `{ type: 'internal', handler }` |
| `filter`    | JSON?        | Optional — equality-match keys on `payload.data`                        |
| `isEnabled` | Boolean      | Indexed. Only enabled hooks load into the cache.                        |
| `createdBy` | FK → User    |                                                                         |

## Event Types

Defined in `HOOK_EVENT_TYPES` in `lib/orchestration/hooks/types.ts`:

| Event Type               | Currently Emitted By                               |
| ------------------------ | -------------------------------------------------- |
| `workflow.started`       | `lib/orchestration/engine/orchestration-engine.ts` |
| `workflow.completed`     | `lib/orchestration/engine/orchestration-engine.ts` |
| `workflow.failed`        | `lib/orchestration/engine/orchestration-engine.ts` |
| `message.created`        | `lib/orchestration/chat/streaming-handler.ts`      |
| `conversation.started`   | _Not emitted anywhere in current codebase_         |
| `conversation.completed` | _Not emitted anywhere in current codebase_         |
| `agent.updated`          | _Not emitted anywhere in current codebase_         |
| `budget.warning`         | _Not emitted anywhere in current codebase_         |

Hooks can be configured for unemitted types — they simply never fire until a caller of `emitHookEvent()` is added.

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

## Registering an Internal Handler

```ts
import { registerInternalHandler } from '@/lib/orchestration/hooks/registry';

registerInternalHandler('log-workflow-completion', async (payload) => {
  logger.info('Workflow completed', payload.data);
});
```

The handler is keyed by name. An admin then creates a hook with `action: { type: 'internal', handler: 'log-workflow-completion' }`. If the hook fires and no matching handler is registered, it logs `Hook internal handler not found` and drops the event.

**Note:** As of this writing, no `registerInternalHandler` calls exist outside tests. The internal-action code path is wired up but unused.

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

- `POST` with `Content-Type: application/json` plus any user-supplied headers
- Body is the full `HookEventPayload`
- 10-second timeout via `AbortSignal.timeout(10_000)`
- **No signing, no retry, no delivery log** — a non-2xx response is logged and discarded
- URLs are SSRF-validated via `isSafeProviderUrl` in the Zod schema on create/update (blocks RFC1918, metadata endpoints, etc.)

## Cache Behaviour

- Enabled hooks load from the DB into a module-level `Map<eventType, CachedHook[]>`
- **TTL:** 60 seconds (`CACHE_TTL_MS`)
- Any hook CRUD operation (POST, PATCH, DELETE) calls `invalidateHookCache()` so admin changes take effect immediately
- The cache is per-process — in a multi-instance deployment each instance independently reloads within 60s of a change

## Admin API

All routes require admin auth (`withAdminAuth`). Mutations are rate-limited via `adminLimiter`.

| Method   | Path                                    | Description                                      |
| -------- | --------------------------------------- | ------------------------------------------------ |
| `GET`    | `/api/v1/admin/orchestration/hooks`     | Paginated list (`?page`, `?limit`, `?eventType`) |
| `POST`   | `/api/v1/admin/orchestration/hooks`     | Create a hook                                    |
| `GET`    | `/api/v1/admin/orchestration/hooks/:id` | Fetch one hook                                   |
| `PATCH`  | `/api/v1/admin/orchestration/hooks/:id` | Update (all fields optional)                     |
| `DELETE` | `/api/v1/admin/orchestration/hooks/:id` | Hard delete                                      |

Validation: `createHookSchema` / `updateHookSchema` in the route files use Zod with a discriminated union on `action.type`. Webhook URLs pass through `isSafeProviderUrl`; the `id` path param must be a CUID.

## Related Docs

- [Webhook Management UI](../admin/orchestration-webhooks.md) — the separate HMAC-signed outbound webhook subsystem
- [Resilience](./resilience.md) — error-handling patterns across orchestration
- [Orchestration Admin API](./admin-api.md) — full admin HTTP surface
