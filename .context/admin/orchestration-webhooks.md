# Webhook Management UI

Admin UI for managing webhook subscriptions. Full CRUD with delivery history, retry, and test ping.

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

- Table columns: URL (truncated + description), events (badges, max 3 + overflow count), delivery count, active Switch, created date, row actions dropdown (Edit, Delete)
- Active filter dropdown, pagination
- Inline active/inactive toggle via `Switch` — optimistic update with revert on failure
- Row actions dropdown with Edit (navigates to edit page) and Delete (AlertDialog confirmation)
- Create button links to `/event-subscriptions/new`. The DLQ surface is reached via the tabbed nav, not a separate button.

### `WebhookForm`

`components/admin/orchestration/webhook-form.tsx`

- URL input (required) with safety hint (private IPs, localhost, metadata endpoints blocked)
- Signing secret input with auto-generate button (`whsec_` prefix + 32 random hex chars)
- 12 event checkboxes from `WEBHOOK_EVENT_TYPES` (including `execution_crashed` for engine-crash alerts — see [Hooks](../orchestration/hooks.md#event-types))
- Description textarea
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

- Lists `exhausted` deliveries across all subscriptions the calling admin owns — single console for the "what's currently dead-lettered" question that the per-subscription view can't answer cleanly.
- Filters: subscription, event type, From / To date range. Filter changes refetch from `GET /webhooks/dlq`.
- Each row links to its parent subscription's edit page and shows event, last response code, attempts, last error.
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

## API Endpoints

Uses admin orchestration webhook endpoints:

- `GET /webhooks` — list (includes `_count.deliveries`)
- `POST /webhooks` — create
- `GET /webhooks/:id` — get
- `PATCH /webhooks/:id` — update
- `DELETE /webhooks/:id` — delete
- `POST /webhooks/:id/test` — send test ping event
- `GET /webhooks/:id/deliveries` — delivery history (scoped to `session.user.id`)
- `POST /webhooks/deliveries/:id/retry` — retry failed delivery (verifies parent subscription ownership)
- `DELETE /webhooks/deliveries/:id` — permanently delete a delivery row (verifies parent subscription ownership, audit-logged as `webhook_delivery.delete`)
- `GET /webhooks/dlq?page=&pageSize=&subscriptionId=&eventType=&since=&until=` — list exhausted deliveries across all subscriptions the calling admin owns. Always scoped to `status=exhausted` and the caller's subscriptions; filters narrow further.
- `GET /webhooks/dlq/stats` — depth signal for the health dashboard. Returns `{ exhausted24h, exhaustedTotal, oldestExhaustedAt }` scoped to the caller's subscriptions. Consumed by improvement #41 (health dashboard).
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
