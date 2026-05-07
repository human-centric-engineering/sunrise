# Inbound triggers

Vendor-neutral primitive for receiving signed events from third-party systems and starting workflow executions. Lives in `lib/orchestration/inbound/` and `app/api/v1/inbound/[channel]/[slug]/route.ts`.

Three first-party adapters ship in-repo, opt-in by env-var presence: `slack`, `postmark`, `hmac` (generic). The shape mirrors the OTEL plug-in pattern — small adapter interface, env-driven self-registration, no admin UI in v1.

## Quick start — per channel

Pick the channel that matches your sender. Each section ends with the per-trigger DB row a fork creates (seed file, migration, or admin tool).

### Slack (single-workspace)

1. Create a Slack app at <https://api.slack.com/apps>. Enable Event Subscriptions; choose the bot scopes you need (`message.channels`, `app_mention`, …).
2. Set the **Request URL** to `https://<your-app>/api/v1/inbound/slack/<workflow-slug>`.
3. Copy the app's **Signing Secret** from "Basic Information".
4. Set the env var:
   ```bash
   SLACK_SIGNING_SECRET=8f1a...
   ```
5. Insert an `AiWorkflowTrigger` row:
   ```ts
   await prisma.aiWorkflowTrigger.create({
     data: {
       workflowId: '<workflow-id>',
       channel: 'slack',
       name: 'Triage Slack mentions',
       metadata: { eventTypes: ['app_mention'] }, // optional allow-list
       isEnabled: true,
       createdBy: '<user-id>',
     },
   });
   ```

Multi-workspace OAuth is **explicitly out of scope for v1** — the adapter assumes a single signing secret. Forks needing multi-workspace can install the app per-workspace and bind each workspace's Slack URL to a different workflow slug.

### Postmark inbound parse

1. Create an inbound stream in Postmark; in "Inbound Webhook" set:
   - URL: `https://<your-app>/api/v1/inbound/postmark/<workflow-slug>`
   - Basic-auth username + password (Postmark's "Inbound Basic Auth" feature)
2. Set the env vars:
   ```bash
   POSTMARK_INBOUND_USER=postmark-inbound
   POSTMARK_INBOUND_PASS=<long-random>
   ```
3. Configure your DNS / domain forwarding so the inbound address routes to Postmark.
4. Insert an `AiWorkflowTrigger` row with `channel: 'postmark'`. `metadata` is optional (no `eventTypes` filter — Postmark only delivers `inbound_email`).

Attachments pass through with their Postmark-supplied base64 `Content` intact in `inputData.trigger.attachments[]`. Forks that don't want binaries on the execution row can filter them in a workflow transform step or persist them via `upload_to_storage` early in the workflow.

### Generic HMAC

For any sender that can produce a SHA-256 HMAC over `${timestamp}.${rawBody}` with a per-trigger secret. Reuses Sunrise's outbound webhook signing scheme (`X-Sunrise-Signature: sha256=…` + `X-Sunrise-Timestamp`).

1. Generate a per-trigger secret:
   ```ts
   import { generateHookSecret } from '@/lib/orchestration/hooks/signing';
   const secret = generateHookSecret(); // 64-hex-char random
   ```
2. Insert an `AiWorkflowTrigger` row with `channel: 'hmac'` and `signingSecret: secret`.
3. Hand the secret to the sender once. Sender computes:
   ```js
   const ts = Math.floor(Date.now() / 1000);
   const body = JSON.stringify(payload);
   const sig =
     'sha256=' + crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
   // POST with headers:
   //   X-Sunrise-Signature: <sig>
   //   X-Sunrise-Timestamp: <ts>
   ```
4. Senders that want **replay dedup** include `eventId` (string) at the top level of the JSON body. The body is HMAC-signed, so the eventId is bound to the signature — an attacker who captures one valid request cannot mutate the eventId to bypass dedup. Senders that omit `eventId` get no event-level dedup; the only protection is the 5-minute timestamp window.

`POSTMARK_INBOUND_USER` / `POSTMARK_INBOUND_PASS` and `SLACK_SIGNING_SECRET` are not used by this channel — they're per-channel env vars for the other adapters.

## Module layout

```
lib/orchestration/inbound/
├── types.ts             # InboundAdapter, NormalisedTriggerPayload, VerifyContext, VerifyResult
├── registry.ts          # getInboundAdapter / registerInboundAdapter / listInboundChannels / resetInboundAdapters
├── bootstrap.ts         # bootstrapInboundAdapters() — env-driven self-registration; idempotent
├── adapters/
│   ├── generic-hmac.ts  # GenericHmacAdapter — per-trigger HMAC, body-bound eventId
│   ├── postmark.ts      # PostmarkAdapter — Basic-auth, email-shape normalisation
│   └── slack.ts         # SlackAdapter — single-workspace HMAC + url_verification handshake
└── index.ts             # barrel export

app/api/v1/inbound/[channel]/[slug]/route.ts  # the single inbound HTTP entry point
```

The route imports `bootstrapInboundAdapters()` at module level; the call is idempotent. Channels with no env-var config remain unregistered and the route returns 404 for them — there is no "channel disabled" intermediate state, mirroring how an unset `OTEL_EXPORTER_OTLP_ENDPOINT` produces no spans.

## Request flow

```
POST /api/v1/inbound/:channel/:slug
  ↓ rate limit (60 req/min per channel+IP)
  ↓ channel + slug regex validation
  ↓ adapter = getInboundAdapter(channel)         → 404 if unregistered
  ↓ rawBody = await request.text()
  ↓ bodyParsed = JSON.parse(rawBody)             (best-effort; null on parse fail)
  ↓ adapter.handleHandshake?(bodyParsed)         → return early (Slack url_verification)
  ↓ trigger = prisma.aiWorkflowTrigger.findFirst({channel, workflow.slug, isEnabled})
  ↓                                              → 404 if missing or workflow inactive
  ↓ adapter.verify(req, {signingSecret, metadata, rawBody})  → 401 if invalid (reason logged, not surfaced)
  ↓ normalised = adapter.normalise(bodyParsed, headers)
  ↓ optional metadata.eventTypes filter           → 200 {skipped} if filtered
  ↓ compute dedupKey per channel                  (see "Replay protection" below)
  ↓ workflowDefinitionSchema.safeParse(snapshot)  → 500 on operator error
  ↓ prisma.aiWorkflowExecution.create({...dedupKey})
  ↓                                              → 200 {deduped: true} if P2002 on dedupKey
  ↓ trigger.lastFiredAt update (best-effort)
  ↓ logAdminAction(workflow_trigger.fire)
  ↓ void drainEngine(...)                        # fire-and-forget; identical crash handling to schedule path
  ↓ 202 {executionId, channel, workflowSlug, status: 'pending'}
```

## Adapter interface

```ts
interface InboundAdapter {
  readonly channel: string;
  handleHandshake?(rawBody: unknown): Response | null;
  verify(req: NextRequest, ctx: VerifyContext): Promise<VerifyResult>;
  normalise(rawBody: unknown, headers: Headers): NormalisedTriggerPayload;
}

interface VerifyContext {
  signingSecret: string | null; // per-trigger secret (HMAC channels only)
  metadata: Record<string, unknown>; // free-form per-trigger config
  rawBody: string; // exact bytes that the HMAC was computed over
}

type VerifyResult =
  | { valid: true; externalId?: string }
  | { valid: false; reason: VerifyFailureReason };

type VerifyFailureReason =
  | 'missing_signature'
  | 'bad_format'
  | 'stale_timestamp'
  | 'bad_signature'
  | 'missing_secret_config'
  | 'unauthorized';
```

Implementations MUST NOT throw — return a structured failure instead. `verify` MUST use constant-time comparisons for any HMAC / shared-secret check. `normalise` MUST NOT perform I/O.

## Normalised payload — per channel

The `payload` field of `NormalisedTriggerPayload` is **per-channel and versioned**. Adapters MUST keep the shape stable; additive changes only. Workflow templates reference fields with `{{ trigger.<field> }}` (top-level) or `{{ trigger.body.<field> }}` for generic-HMAC.

### Slack

| Field         | Type   | Source                    | Notes                               |
| ------------- | ------ | ------------------------- | ----------------------------------- |
| `teamId`      | string | `body.team_id`            | Workspace ID                        |
| `appId`       | string | `body.api_app_id`         | Slack app ID                        |
| `eventTime`   | number | `body.event_time`         | Unix epoch seconds                  |
| `type`        | string | `body.event.type`         | `message`, `app_mention`, …         |
| `user`        | string | `body.event.user`         | Slack user ID; empty for bot events |
| `botId`       | string | `body.event.bot_id`       | Set when the event is from a bot    |
| `channel`     | string | `body.event.channel`      | Slack channel ID                    |
| `channelType` | string | `body.event.channel_type` | `channel`, `im`, …                  |
| `text`        | string | `body.event.text`         | Message body                        |
| `ts`          | string | `body.event.ts`           | Slack timestamp (string, not epoch) |
| `threadTs`    | string | `body.event.thread_ts`    | Set when the event is in a thread   |

`externalId` is set from `body.event_id` (Slack's globally unique event ID).
`eventType` is set from `body.event.type`.

### Postmark

| Field                         | Type   | Source                   |
| ----------------------------- | ------ | ------------------------ |
| `from.email`                  | string | `body.FromFull.Email`    |
| `from.name`                   | string | `body.FromFull.Name`     |
| `to[]`                        | array  | `body.ToFull[]`          |
| `to[].email`                  | string | `.Email`                 |
| `to[].name`                   | string | `.Name`                  |
| `to[].mailboxHash`            | string | `.MailboxHash`           |
| `cc[]`                        | array  | `body.CcFull[]`          |
| `cc[].email`                  | string | `.Email`                 |
| `cc[].name`                   | string | `.Name`                  |
| `subject`                     | string | `body.Subject`           |
| `messageId`                   | string | `body.MessageID`         |
| `date`                        | string | `body.Date`              |
| `textBody`                    | string | `body.TextBody`          |
| `htmlBody`                    | string | `body.HtmlBody`          |
| `strippedTextReply`           | string | `body.StrippedTextReply` |
| `mailboxHash`                 | string | `body.MailboxHash`       |
| `messageStream`               | string | `body.MessageStream`     |
| `attachments[]`               | array  | `body.Attachments[]`     |
| `attachments[].name`          | string | `.Name`                  |
| `attachments[].contentType`   | string | `.ContentType`           |
| `attachments[].contentLength` | number | `.ContentLength`         |
| `attachments[].contentBase64` | string | `.Content`               |
| `attachments[].contentId`     | string | `.ContentID`             |

`externalId` is set from `body.MessageID`.
`eventType` is hard-coded to `'inbound_email'`.

### Generic HMAC

| Field  | Type    | Source                                  |
| ------ | ------- | --------------------------------------- |
| `body` | unknown | The full parsed JSON body, pass-through |

`externalId` is read from `body.eventId` (top-level string field).
`eventType` is read from `body.eventType` (top-level string field).
Both are STRICT — non-string and empty-string values produce no `externalId` / `eventType`.

Workflow templates reference fields with `{{ trigger.body.<field> }}`.

## Replay protection

Every successful execution insert carries a `dedupKey` column with a Postgres `UNIQUE` constraint. The route computes `dedupKey` per-channel based on whether the channel uses a shared signing secret across workflows:

| Channel             | Secret model             | `dedupKey` shape                 | Why                                                                                              |
| ------------------- | ------------------------ | -------------------------------- | ------------------------------------------------------------------------------------------------ |
| `slack`, `postmark` | One secret instance-wide | `<channel>:<externalId>`         | Signing envelope does NOT bind the workflow URL → captured request can replay to other workflows |
| `hmac`              | Per-trigger secret       | `hmac:<workflowId>:<externalId>` | Different secrets per workflow → cross-workflow replay is structurally impossible                |

When `externalId` is null (sender omitted dedup material), `dedupKey` is also null. Postgres treats NULLs as distinct in UNIQUE indexes, so no constraint is enforced — every request inserts a fresh execution row.

When `dedupKey` collision happens, the route returns `200 { success: true, data: { deduped: true } }` — the vendor sees a successful ack and stops retrying.

### Threat model — what this defends

- **Slack retries** (`X-Slack-Retry-Num`): Slack re-sends the same `event_id` after a 3-second timeout; the second insert collides on `slack:<event_id>` → 200 ack. ✓
- **Postmark redelivery**: same shape with `MessageID`. ✓
- **Cross-workflow Slack replay**: an attacker who captures one valid Slack delivery cannot replay it against a different Slack-bound workflow on the same instance — both inserts compute the same `slack:<event_id>` and the second collides. ✓
- **Generic-HMAC eventId mutation**: senders include `eventId` in the SIGNED body, not in a header. Mutation invalidates the signature. ✓

### What this does NOT defend

- Senders that omit `eventId` from the body (or use generic-HMAC without it) get no event-level dedup. The 5-minute timestamp window in `verifyHookSignature` is the only protection. Documented as the sender-side trade.
- Two unrelated HMAC triggers on different workflows that legitimately use the same `eventId` value will NOT collide — this is intentional, since the per-trigger secret model means cross-workflow replay can't happen anyway.

## Environment variables

| Variable                | Channel    | Required to enable           | Notes                                                          |
| ----------------------- | ---------- | ---------------------------- | -------------------------------------------------------------- |
| `SLACK_SIGNING_SECRET`  | `slack`    | Yes (or channel returns 404) | App's Signing Secret from Slack's "Basic Information"          |
| `POSTMARK_INBOUND_USER` | `postmark` | Yes (with `_PASS`)           | Inbound stream's Basic-auth username                           |
| `POSTMARK_INBOUND_PASS` | `postmark` | Yes (with `_USER`)           | Inbound stream's Basic-auth password                           |
| (none)                  | `hmac`     | Always registered            | Per-trigger secret stored on `AiWorkflowTrigger.signingSecret` |

Empty-string env vars are treated as unset (truthiness check). Bootstrap logs the registered channels at INFO; nothing alerts when an expected channel is missing — operators should verify the boot log when shipping a new channel.

## Anti-patterns

- **Don't read dedup material from unsigned headers.** The earlier draft of `GenericHmacAdapter` read `X-Sunrise-Event-Id` directly from headers; an attacker could trivially mutate the header to bypass dedup on a captured request. The current adapter reads `eventId` from the signed body only. The same caution applies if you write a new adapter — anything you key dedup on must be inside the signed envelope.
- **Don't bypass the registry.** The adapter registry is the single source of truth for which channels are active. Writing a one-off `if (channel === 'foo')` branch in the route would skip rate-limiting hooks, audit logs, and `lastFiredAt` updates that all converge in one place today.
- **Don't include the request body in error responses.** `verify` failures log the structured `reason` (`bad_signature`, `stale_timestamp`, …) but the route returns a uniform 401 with no body content beyond the standard error envelope. Surfacing the reason would let attackers probe which check failed.
- **Don't extend `verify` to perform I/O.** `verify` runs synchronously after a fast rate-limit + parse step; database / network calls inside it would balloon p99 latency and create new failure modes. Per-trigger config comes through `VerifyContext` which is pre-resolved by the route.
- **Don't add a new shared-secret channel without reviewing the dedup-scope branch.** Lines 220-225 of `route.ts` decide channel-global vs per-trigger scope based on `channel === 'hmac'`. A new shared-secret channel (e.g. GitHub webhooks, Stripe events) needs to fall into the channel-global branch — that's the default today, so it works automatically. A new per-trigger-secret channel needs explicit handling. Encoding this as a property on the adapter would be a worthwhile future refactor.

## Testing

Adapter tests are under `tests/unit/lib/orchestration/inbound/`. The route has both a unit test (`tests/unit/app/api/v1/inbound/[channel]/[slug]/route.test.ts`) and an integration test (`tests/integration/api/v1/inbound/[channel]/[slug]/route.test.ts`). Integration tests follow the project convention of mocking `@/lib/db/client` rather than running a testcontainer — `vi.mock('@/lib/db/client')` is the boundary, and DB-state assertions are made via `expect(prismaMock.X.create).toHaveBeenCalledWith({...})`.

Test fixtures notable enough to know about:

- Slack signature generation: `crypto.createHmac('sha256', secret).update(\`v0:\${ts}:\${body}\`).digest('hex')`. Tests pin the clock with `vi.useFakeTimers()` for window-boundary cases.
- Generic-HMAC signature generation: `signHookPayload(secret, rawBody, tsSec)` from `@/lib/orchestration/hooks/signing`.
- Postmark Basic auth: `Buffer.from('user:pass').toString('base64')`.
- For the cross-workflow Slack replay regression test: the integration suite captures the `dedupKey` from a first-leg create call and asserts the second-leg call (different workflow, same `event_id`) produces the SAME dedupKey — proving the database UNIQUE would block the replay on a real Postgres instance.

156 tests across 7 files at the time of writing.

## Related docs

- [Scheduling & webhooks](./scheduling.md) — outbound webhook subscriptions and the existing `POST /api/v1/webhooks/trigger/:slug` API-key-auth path; use that when the sender can issue an `Authorization: Bearer sk_…` header and you don't need vendor-specific normalisation.
- [Workflow versioning](./workflow-versioning.md) — every inbound-triggered execution is pinned to the workflow's published version at insert time.
- [Tracing (OTEL plug-in)](./tracing.md) — the architectural template this feature follows: vendor-neutral interface, env-driven adapter registration, opt-in shipping.
- [Hooks](./hooks.md) — outbound event dispatch (the inverse direction of inbound triggers).
