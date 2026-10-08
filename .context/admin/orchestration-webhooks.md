# Event Subscriptions UI

Admin UI for managing event subscriptions. Each subscription delivers
matching events to **one** of two channels:

- **Webhook** — HMAC-signed JSON POST to a URL you provide. Best for
  programmatic receivers (your backend, Zapier / n8n, Slack's
  incoming-webhook URL, etc.).
- **Email** — formatted email via Resend, rendered from the same
  payload a webhook receiver would have seen. Best for human
  notifications.

One subscription = one channel. Need both? Create two subscriptions.
Both share the same retry policy, DLQ behaviour, and per-row audit
trail (`AiWebhookDelivery`).

Historically this surface was webhook-only — the model is still named
`AiWebhookSubscription` and the routes are still under `/webhooks`
for API compatibility. The `channel` column on the row discriminates
which destination fields are used.

**Route:** `/admin/orchestration/event-subscriptions` (page-level label is "Event Subscriptions" — the underlying mechanism is still webhooks)

## Pages

| Route                                              | File                                                        | Purpose                                                                            |
| -------------------------------------------------- | ----------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `/admin/orchestration/event-subscriptions`         | `app/admin/orchestration/event-subscriptions/page.tsx`      | Tabbed surface: Subscriptions list + Dead Letter Queue (URL-synced via `?tab=...`) |
| `/admin/orchestration/event-subscriptions?tab=dlq` | same page                                                   | Active deep link for the dead-letter queue tab                                     |
| `/admin/orchestration/event-subscriptions/new`     | `app/admin/orchestration/event-subscriptions/new/page.tsx`  | Create subscription form                                                           |
| `/admin/orchestration/event-subscriptions/[id]`    | `app/admin/orchestration/event-subscriptions/[id]/page.tsx` | Edit subscription + test button + deliveries                                       |
| `/admin/orchestration/event-subscriptions/dlq`     | `app/admin/orchestration/event-subscriptions/dlq/page.tsx`  | Redirect to `?tab=dlq` for back-compat with earlier links                          |

## Components

### `EventSubscriptionsTabs`

`components/admin/orchestration/event-subscriptions-tabs.tsx`

- URL-synced tabs (`useUrlTabs`) at the top of the page: **Subscriptions** (default) and **Dead Letter Queue**.
- Both tabs are server-seeded by the parent page so `?tab=dlq` deep links render without a client-side fetch flash.
- The DLQ tab also renders a Dead Letter Queue overview FieldHelp explaining what lands here and the available actions (retry, discard, bulk replay).

### `WebhooksTable`

`components/admin/orchestration/webhooks-table.tsx`

- Table columns: URL (truncated + description), events (badges, max 3 + overflow count, plus a `Scoped` badge when the row has any `agentIds` / `workflowIds` set), delivery count, active Switch, created date, row actions dropdown (Edit, Delete)
- Active filter dropdown, pagination
- Inline active/inactive toggle via `Switch` — optimistic update with revert on failure
- Row actions dropdown with Edit (navigates to edit page) and Delete (AlertDialog confirmation)
- Create button links to `/event-subscriptions/new`. The DLQ surface is reached via the tabbed nav, not a separate button.

### `WebhookForm`

`components/admin/orchestration/webhook-form.tsx`

- URL input (required) with safety hint (private IPs, localhost, metadata endpoints blocked)
- Signing secret input with auto-generate, reveal/hide eye toggle, and clipboard-copy buttons. Generating a secret auto-reveals it so the user can capture it before saving. While the field has a value, an amber notice reminds the user to copy now — Sunrise never returns the secret again after save (the API's `SAFE_SELECT` strips it from every GET).
- 12 event checkboxes from `WEBHOOK_EVENT_TYPES` (including `execution_crashed` for engine-crash alerts — see [Hooks](../orchestration/hooks.md#event-types))
- Description textarea
- **Scope block** (between Events and Retry policy): two async-search `MultiSelect`s — "Limit to agents" and "Limit to workflows". Each multi-selects from the matching admin list endpoint (`?q=` server-side search, 50-row page, names rendered on chips via a pre-fetch). Both default to empty = "all agents / all workflows". Cap: 50 entries per dimension. Filters apply **dimension-specifically** (see [Entity-Scoped Subscriptions](../orchestration/hooks.md#entity-scoped-subscriptions)) — an agent filter does not restrict workflow-typed events and vice versa.
- Retry policy block: `maxAttempts` (1–10) and `retryBackoffSeconds` (comma-separated seconds, each 1–86400). Form input is seconds; API field is `retryBackoffMs` (millisecond array). Defaults: 3 attempts with `10, 60, 300` seconds. The form blocks submit unless the array has at least `maxAttempts - 1` entries.
- Active toggle
- In edit mode, empty secret field = keep current secret

### `WebhookTestButton`

`components/admin/orchestration/webhook-test-button.tsx`

- "Send test event" button shown on the edit page between the form and delivery history
- Sends a `ping` event to the configured URL via `POST /webhooks/:id/test`
- If the subscription has no signing secret, returns an error without dispatching ("Webhook has no signing secret. Set a secret before testing.")
- Displays result inline: green "Ping delivered (status) in Xms" or red error message
- 5-second timeout, uses the same HMAC signature flow as real deliveries

### `WebhookDlqTable`

`components/admin/orchestration/webhook-dlq-table.tsx`

- Lists `exhausted` deliveries across all subscriptions the calling admin owns, plus any whose subscription was deleted — single console for the "what's currently dead-lettered" question that the per-subscription view can't answer cleanly.
- Filters: subscription, event type, From / To date range. Filter changes refetch from `GET /webhooks/dlq`.
- Each row links to its parent subscription's edit page and shows the destination recorded on the delivery, event, last response code, attempts, last error.
- A row whose subscription was deleted reads "Deleted subscription" with its recorded destination ("Destination not recorded" on rows that predate recording), has no link, and cannot be retried. It can still be discarded.
- Row actions: retry (calls `POST /webhooks/deliveries/:id/retry`, same path as the per-subscription view) and discard (calls `DELETE /webhooks/deliveries/:id`, AlertDialog confirmation).
- **Bulk replay** button hits `POST /webhooks/dlq/replay`. With a subscription filter active, replays every exhausted row for that subscription (and respects the "To" date as a cutoff); without one, replays the rows visible on the current page.
- Pagination through `parsePaginationMeta`.

### `WebhookDeliveries`

`components/admin/orchestration/webhook-deliveries.tsx`

- Delivery history table for a specific webhook
- Columns: timestamp, event type, status badge (delivered/pending/failed/exhausted), HTTP response code, attempts, last error, retry button
- Status filter (all/delivered/pending/failed/exhausted)
- Retry button for failed/exhausted deliveries
- `lastError` column shows truncated error message for failed deliveries

## Where a delivery went

A delivery row records its own destination, because its subscription holds
only the current one and can be edited or deleted (§109 t-739). The rule and
its reasoning live in `lib/orchestration/webhooks/destination.ts`; in short:

- **`destination`** is what an admin reads: the URL reduced to its origin and
  path (`loggableUrl`: no query string, userinfo or fragment, and id-like path
  segments collapsed to `[param]`), or the email address. A webhook URL often
  carries its credential in one of those parts, so the row never stores it.
- **`destinationFingerprint`** is a keyed HMAC of the full destination
  (`v1:…`). The reduced form cannot tell one Slack webhook from another; the
  fingerprint can. From a server shell, `fingerprintDestination('webhook', url)`
  answers "was this delivery sent to exactly this URL?". It is keyed from
  `BETTER_AUTH_SECRET`, so rotating that secret makes earlier fingerprints
  unverifiable.
- **Retries follow the subscription's current destination.** When that has
  changed since the last attempt, the previous pair moves into
  `previousDestinations` (`[{ destination, destinationFingerprint, until }]`),
  so the row names every place the payload was sent.
- **Deleting a subscription keeps its deliveries** (`subscriptionId` becomes
  null). So does erasing the admin who created it: the subscription goes with
  them, but the deliveries are the org's record of where its customers' data
  went. A retry of an orphaned delivery is refused; the DLQ shows orphans to
  every admin, since there is no creator left to scope them by. Erasing the
  org still removes its deliveries, and retention prunes orphans by age like
  any other row.
- **Rows that predate recording** are filled from their subscription's
  current destination by the `022-delivery-destinations` seed unit, which is
  the best value available rather than a record. Rows whose subscription was
  already gone stay null.

Event-hook deliveries (`AiEventHookDelivery`) follow the same rules; see
[Event hooks](../orchestration/hooks.md#deliveries).

## Channel Behaviour

| Aspect              | Webhook channel                          | Email channel                                                           |
| ------------------- | ---------------------------------------- | ----------------------------------------------------------------------- |
| Destination field   | `url` (validated by `isSafeProviderUrl`) | `emailAddress` (RFC-shape check)                                        |
| Auth                | HMAC-SHA256 via `secret`                 | None — the channel is the auth                                          |
| Payload             | JSON POST                                | React Email template (`emails/event-notification.tsx`)                  |
| Retry semantics     | Per-subscription `maxAttempts` + DLQ     | Same (against Resend); Resend also retries on its side                  |
| Audit row           | `AiWebhookDelivery`                      | `AiWebhookDelivery` (same table)                                        |
| Config requirements | None                                     | `RESEND_API_KEY` + `EMAIL_FROM` must be set; otherwise marked exhausted |

The generic email template renders the same `{ event, timestamp, data }`
payload a webhook receiver would get — title from the event type, a
key/value detail table for non-action fields, a `changes` block with
from→to colouring, and Approve/Reject buttons when the payload
includes `approveUrl` / `rejectUrl` (i.e. `approval_required`).

## API Endpoints

Uses admin orchestration webhook endpoints:

- `GET /webhooks` — list (includes `_count.deliveries`)
- `POST /webhooks` — create
- `GET /webhooks/:id` — get
- `PATCH /webhooks/:id` — update
- `DELETE /webhooks/:id` — delete (its deliveries are kept; see [Where a delivery went](#where-a-delivery-went))
- `POST /webhooks/:id/test` — send test ping event
- `GET /webhooks/:id/deliveries` — delivery history (scoped to `session.user.id`)
- `POST /webhooks/deliveries/:id/retry` — retry failed delivery (verifies parent subscription ownership; 409 when the subscription was deleted)
- `DELETE /webhooks/deliveries/:id` — permanently delete a delivery row (verifies parent subscription ownership, or that it was deleted; audit-logged as `webhook_delivery.delete`, naming the reduced destination)
- `GET /webhooks/dlq?page=&pageSize=&subscriptionId=&eventType=&since=&until=` — list exhausted deliveries across all subscriptions the calling admin owns, plus orphaned ones. Always scoped to `status=exhausted` and that scope; filters narrow further.
- `GET /webhooks/dlq/stats` — depth signal for the health dashboard. Returns `{ exhausted24h, exhaustedTotal, oldestExhaustedAt }` over the same scope. Consumed by improvement #41 (health dashboard).
- `POST /webhooks/dlq/replay` — bulk replay. Body either `{ deliveryIds: string[] }` (explicit selection, max 500) or `{ subscriptionId, before? }` (replay all exhausted rows for one subscription, optionally capped by `createdAt < before`). Loops `retryDelivery()` with concurrency cap of 5. Ownership filter skips rows the caller doesn't own. Audit-logged as `webhook_delivery.replay_batch`.

Consumer-facing:

- `POST /api/v1/webhooks/trigger/:slug` — trigger a workflow via webhook (API-key auth, `webhook` scope)

## Signing Schemes

The two outbound webhook subsystems use **different** HMAC-SHA256 signing schemes:

| Aspect            | Webhook Subscriptions                      | Event Hooks                                                            |
| ----------------- | ------------------------------------------ | ---------------------------------------------------------------------- |
| Header            | `X-Webhook-Signature`                      | `X-Sunrise-Signature` + `X-Sunrise-Timestamp`                          |
| Format            | Raw hex digest                             | `sha256=<hex>` prefixed                                                |
| Signed content    | JSON body only                             | `<timestamp>.<body>` (timestamp-prefixed)                              |
| Replay protection | None built-in                              | Timestamp in signed string; `verifyHookSignature` rejects >5 min drift |
| Implementation    | `lib/orchestration/webhooks/dispatcher.ts` | `lib/orchestration/hooks/signing.ts`                                   |

Receivers integrating with both must check for the appropriate header to determine which scheme to verify against.

## Sidebar

Linked from the admin sidebar under AI Orchestration as "Event Subscriptions", in the Operate subgroup after Approval Queue. Icon: `Webhook` from lucide-react.

## Related

- [Scheduling & Webhooks](../orchestration/scheduling.md)
- [Admin API reference](../orchestration/admin-api.md)
