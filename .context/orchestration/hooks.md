# Event Hooks

In-process event dispatch for orchestration lifecycle events. Admins configure hooks that fire on events like `workflow.completed` or `message.created`, routing them to an outbound webhook URL.

> **Source of truth:** `lib/orchestration/hooks/`. Update this doc when those files change.

## Hooks vs. Webhook Subscriptions

These are two different subsystems — don't confuse them:

| System                     | Model                                         | Purpose                                                      | Signing                             | Retry                     |
| -------------------------- | --------------------------------------------- | ------------------------------------------------------------ | ----------------------------------- | ------------------------- |
| **Event Hooks** (this doc) | `AiEventHook` / `AiEventHookDelivery`         | Lightweight fire-and-forget dispatch on lifecycle events     | Optional HMAC-SHA256 (`secret` set) | 3 attempts (10s/60s/300s) |
| Webhook Subscriptions      | `AiWebhookSubscription` / `AiWebhookDelivery` | Durable outbound notifications with per-delivery audit trail | HMAC-SHA256 via `secret` field      | 3 attempts (10s/60s/300s) |

Both subsystems can sign outbound payloads. Pick the subsystem based on delivery semantics (lightweight in-process dispatch vs. durable per-delivery audit); for signing setup and headers, see the table above.

## Module Layout

```
lib/orchestration/hooks/
├── registry.ts    # emitHookEvent, invalidateHookCache
├── serialize.ts   # toSafeHook (strips secret, adds hasSecret)
├── signing.ts     # generateHookSecret, signHookPayload, verifyHookSignature
└── types.ts       # HOOK_EVENT_TYPES, HookAction, HookFilter, HookEventPayload
```

## Data Model

`AiEventHook` — stored in `ai_event_hook`:

| Field       | Type         | Notes                                                                                       |
| ----------- | ------------ | ------------------------------------------------------------------------------------------- |
| `id`        | CUID         | Primary key                                                                                 |
| `name`      | String       | Human label (max 200)                                                                       |
| `eventType` | VarChar(100) | One of `HOOK_EVENT_TYPES` (indexed)                                                         |
| `action`    | JSON         | `{ type: 'webhook', url, headers? }`                                                        |
| `filter`    | JSON?        | Optional — equality-match keys on `payload.data`                                            |
| `isEnabled` | Boolean      | Indexed. Only enabled hooks load into the cache.                                            |
| `secret`    | String?      | Optional HMAC-SHA256 signing key (hex). When set, outbound dispatches carry signed headers. |
| `createdBy` | FK → User    |                                                                                             |

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
- **Optional HMAC-SHA256 signing** when the hook has a `secret` — see [Signing](#signing) below
- On non-2xx / network error: updates the delivery row with `lastResponseCode` / `lastError` and schedules an in-process retry (up to 3 attempts at 10s / 60s / 300s). If the process restarts mid-backoff, `processPendingHookRetries()` picks stale rows up on the next maintenance tick.
- URLs are SSRF-validated via `isSafeProviderUrl` in the Zod schema on create/update (blocks RFC1918, metadata endpoints, etc.)

## Signing

When `AiEventHook.secret` is set, the registry signs each outbound body with HMAC-SHA256 and sends two extra headers. The scheme follows the Stripe/GitHub pattern so standard verifier code works unmodified.

**Outbound headers** (only when `secret` is set):

| Header                | Value                                                                          |
| --------------------- | ------------------------------------------------------------------------------ |
| `X-Sunrise-Timestamp` | Unix epoch second (as a string) used to compute the signature                  |
| `X-Sunrise-Signature` | `sha256=<hex>` where `<hex>` = `HMAC_SHA256(secret, "<timestamp>.<raw body>")` |

The timestamp is refreshed on every attempt — retries do **not** re-send the original signature, so receivers that enforce a max-age tolerance still accept the retry. Unsigned hooks (no secret) carry the normal `Content-Type` / `X-Hook-Event` / user-custom headers and nothing else.

`X-Sunrise-Signature` and `X-Sunrise-Timestamp` are reserved: the create/update routes reject `action.headers` whose keys collide (case-insensitive) with either name, and the dispatcher spreads custom headers before the computed signing headers so signing always wins as defense-in-depth.

### Receiver verification

`verifyHookSignature` in `lib/orchestration/hooks/signing.ts` is the reference implementation — receivers inside this codebase can import it directly, and external receivers should mirror it:

```ts
import { verifyHookSignature } from '@/lib/orchestration/hooks/signing';

const rawBody = await request.text(); // MUST be the raw body — do not re-serialize parsed JSON
const result = verifyHookSignature(
  secret,
  rawBody,
  request.headers.get('x-sunrise-timestamp'),
  request.headers.get('x-sunrise-signature')
);
if (!result.valid) return new Response('unauthorized', { status: 401 });
```

Behaviour:

- Returns `{ valid: true }` only when the timestamp is an integer, the signature has the `sha256=<hex>` shape, the timestamp is within `±DEFAULT_MAX_AGE_SEC` (5 minutes) of `now`, and a constant-time byte comparison matches. Otherwise `{ valid: false, reason }` with one of `bad_format`, `stale_timestamp`, or `bad_signature` for internal logging — don't surface the reason to the sender.
- Uses `crypto.timingSafeEqual` after an up-front length check so hex-length mismatches don't throw.
- Accepts an options argument `{ maxAgeSec?, nowSec? }` for custom tolerances or deterministic test clocks.

### Secret management

Secrets are stored in plaintext on the `AiEventHook.secret` column (it _is_ the signing key — there is nothing meaningful to hash into). They are never returned from the read endpoints:

- `GET /hooks` and `GET /hooks/:id` strip `secret` and expose `hasSecret: boolean` instead.
- `POST /hooks` and `PATCH /hooks/:id` silently ignore any `secret` field in the request body — secrets only arrive via the rotate endpoint.
- The rotate endpoint returns the new plaintext **once**. Admins must capture it immediately and configure their receiver; there is no re-read path.

Rotate / clear:

| Method   | Path                                                  | Behaviour                                                                                                                                                                                                                                |
| -------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/api/v1/admin/orchestration/hooks/:id/rotate-secret` | Generates a 256-bit hex secret, persists it atomically, invalidates the cache, returns `{ secret, rotatedAt }` once. Audit-logged as `hook.secret.rotated` with `metadata.hadPrevious` indicating whether the hook already had a secret. |
| `DELETE` | `/api/v1/admin/orchestration/hooks/:id/rotate-secret` | Clears the stored secret so subsequent dispatches go out unsigned. Idempotent (returns `cleared: false` when already empty). Audit-logged as `hook.secret.cleared` only on a non-op.                                                     |

**Rotation workflow:**

1. `POST` the rotate endpoint and capture the `secret` from the response.
2. Configure the receiver with the new secret _before_ relying on it — during the window between step 1 and step 3, newly-dispatched events carry a signature only the new secret can verify.
3. If the receiver needs a zero-gap cutover, deploy it to accept _both_ the old and the new secret for one max-age window (5 minutes by default), then remove the old one.

Dispatch uses the cached secret — in multi-instance deployments, each instance reloads the secret within `CACHE_TTL_MS` (60s). During that window different instances may sign with the previous value.

## Cache Behaviour

- Enabled hooks load from the DB into a module-level `Map<eventType, CachedHook[]>`
- **TTL:** 60 seconds (`CACHE_TTL_MS`)
- Any hook CRUD operation (POST, PATCH, DELETE) calls `invalidateHookCache()` so admin changes take effect immediately
- The cache is per-process — in a multi-instance deployment each instance independently reloads within 60s of a change

## Admin API

All routes require admin auth (`withAdminAuth`). Mutations are rate-limited via `adminLimiter`.

| Method   | Path                                                     | Description                                                                        |
| -------- | -------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `GET`    | `/api/v1/admin/orchestration/hooks`                      | Paginated list (`?page`, `?limit`, `?eventType`). Returns `hasSecret` flag.        |
| `POST`   | `/api/v1/admin/orchestration/hooks`                      | Create a hook (any `secret` field in the body is silently dropped)                 |
| `GET`    | `/api/v1/admin/orchestration/hooks/:id`                  | Fetch one hook. Returns `hasSecret` flag; never the secret itself.                 |
| `PATCH`  | `/api/v1/admin/orchestration/hooks/:id`                  | Update (all fields optional; `secret` field is silently dropped)                   |
| `DELETE` | `/api/v1/admin/orchestration/hooks/:id`                  | Hard delete                                                                        |
| `GET`    | `/api/v1/admin/orchestration/hooks/:id/deliveries`       | Paginated delivery history (`?page`, `?pageSize`, `?status`)                       |
| `POST`   | `/api/v1/admin/orchestration/hooks/deliveries/:id/retry` | Manually re-dispatch a `failed` / `exhausted` delivery                             |
| `POST`   | `/api/v1/admin/orchestration/hooks/:id/rotate-secret`    | Generate a fresh HMAC secret; returns the plaintext once. See [Signing](#signing). |
| `DELETE` | `/api/v1/admin/orchestration/hooks/:id/rotate-secret`    | Clear the stored secret so dispatches go out unsigned                              |

Validation: `createHookSchema` / `updateHookSchema` in the route files enforce `action.type === 'webhook'`. Webhook URLs pass through `isSafeProviderUrl`; the `id` path param must be a CUID.

Event hooks currently have no dedicated admin UI — manage them via the API above. The audit-log admin page already exposes `webhook` as a filter value and will now surface `hook.secret.rotated` / `hook.secret.cleared` entries under that bucket.

### Deliveries

Every dispatch attempt creates an `AiEventHookDelivery` row (see [Webhook Action](#webhook-action) above for the lifecycle). The two delivery routes make that history queryable:

- **List** (`GET /hooks/:id/deliveries`) — ordered by `createdAt desc`. The `?status` filter accepts `pending`, `delivered`, `failed`, or `exhausted`. Returns 404 if the parent hook doesn't exist.
- **Retry** (`POST /hooks/deliveries/:id/retry`) — calls `retryHookDelivery()`, which resets `attempts` to 0 and re-dispatches. Only retriable deliveries (`failed` / `exhausted`) are accepted; `pending` / `delivered` rows return 404 with "no longer retriable".

## Retention

Delivery rows persist across process restarts so admins can audit failures and manually retry. They are pruned by `pruneHookDeliveries()` in `lib/orchestration/retention.ts`, invoked from the unified maintenance tick alongside the other retention sweeps.

- **Setting**: shares the `webhookRetentionDays` column on `AiOrchestrationSettings` with outbound webhook subscriptions — event-hook deliveries and subscription deliveries are the same class of dispatch-audit data.
- **Null setting → skip**: if `webhookRetentionDays` is unset the sweep is a no-op and rows accumulate indefinitely.
- **Target table**: `AiEventHookDelivery`. Deletes rows whose `createdAt` is older than `now - webhookRetentionDays`.

See [Retention Pruning](./scheduling.md#retention-pruning) for the full list of prune sweeps.

## Related Docs

- [Webhook Management UI](../admin/orchestration-webhooks.md) — the separate HMAC-signed outbound webhook subsystem
- [Resilience](./resilience.md) — error-handling patterns across orchestration
- [Orchestration Admin API](./admin-api.md) — full admin HTTP surface
