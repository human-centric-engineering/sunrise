# Webhook Management UI

Admin UI for managing webhook subscriptions. Full CRUD with delivery history, retry, and test ping.

**Route:** `/admin/orchestration/webhooks`

## Pages

| Route                                | File                                             | Purpose                                 |
| ------------------------------------ | ------------------------------------------------ | --------------------------------------- |
| `/admin/orchestration/webhooks`      | `app/admin/orchestration/webhooks/page.tsx`      | List all webhooks                       |
| `/admin/orchestration/webhooks/new`  | `app/admin/orchestration/webhooks/new/page.tsx`  | Create webhook form                     |
| `/admin/orchestration/webhooks/[id]` | `app/admin/orchestration/webhooks/[id]/page.tsx` | Edit webhook + test button + deliveries |

## Components

### `WebhooksTable`

`components/admin/orchestration/webhooks-table.tsx`

- Table columns: URL (truncated + description), events (badges, max 3 + overflow count), delivery count, active Switch, created date, row actions dropdown (Edit, Delete)
- Active filter dropdown, pagination
- Inline active/inactive toggle via `Switch` — optimistic update with revert on failure
- Row actions dropdown with Edit (navigates to edit page) and Delete (AlertDialog confirmation)
- Create button links to `/webhooks/new`

### `WebhookForm`

`components/admin/orchestration/webhook-form.tsx`

- URL input (required) with HTTPS-only hint below the field
- Signing secret input with auto-generate button (`whsec_` prefix + 32 random hex chars)
- 11 event checkboxes from `WEBHOOK_EVENT_TYPES`
- Description textarea
- Active toggle
- In edit mode, empty secret field = keep current secret

### `WebhookTestButton`

`components/admin/orchestration/webhook-test-button.tsx`

- "Send test event" button shown on the edit page between the form and delivery history
- Sends a `ping` event to the configured URL via `POST /webhooks/:id/test`
- Displays result inline: green "Ping delivered (status) in Xms" or red error message
- 5-second timeout, uses the same HMAC signature flow as real deliveries

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
- `GET /webhooks/:id/deliveries` — delivery history
- `POST /webhooks/deliveries/:id/retry` — retry failed delivery

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

Linked from the admin sidebar under AI Orchestration, between Workflows and Knowledge Base. Icon: `Webhook` from lucide-react.

## Related

- [Scheduling & Webhooks](../orchestration/scheduling.md)
- [Admin API reference](../orchestration/admin-api.md)
