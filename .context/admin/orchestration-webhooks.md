# Webhook Management UI

Admin UI for managing webhook subscriptions. Full CRUD with delivery history and retry.

**Route:** `/admin/orchestration/webhooks`

## Pages

| Route                                | File                                             | Purpose                         |
| ------------------------------------ | ------------------------------------------------ | ------------------------------- |
| `/admin/orchestration/webhooks`      | `app/admin/orchestration/webhooks/page.tsx`      | List all webhooks               |
| `/admin/orchestration/webhooks/new`  | `app/admin/orchestration/webhooks/new/page.tsx`  | Create webhook form             |
| `/admin/orchestration/webhooks/[id]` | `app/admin/orchestration/webhooks/[id]/page.tsx` | Edit webhook + delivery history |

## Components

### `WebhooksTable`

`components/admin/orchestration/webhooks-table.tsx`

- Table columns: URL (truncated), events (badges, max 3 + overflow count), status (active/inactive dot), created date, actions (edit/delete)
- Active filter toggle, pagination
- Delete with AlertDialog confirmation
- Create button links to `/webhooks/new`

### `WebhookForm`

`components/admin/orchestration/webhook-form.tsx`

- URL input (required)
- Signing secret input with auto-generate button (`whsec_` prefix + 32 random chars)
- 11 event checkboxes from `WEBHOOK_EVENT_TYPES`
- Description textarea
- Active toggle
- In edit mode, empty secret field = keep current secret

### `WebhookDeliveries`

`components/admin/orchestration/webhook-deliveries.tsx`

- Delivery history table for a specific webhook
- Columns: timestamp, event, status (success/failed badge), response code
- Status filter (all/success/failed)
- Retry button for failed/exhausted deliveries

## API Endpoints

Uses admin orchestration webhook endpoints:

- `GET /webhooks` — list
- `POST /webhooks` — create
- `PATCH /webhooks/:id` — update
- `DELETE /webhooks/:id` — delete
- `GET /webhooks/:id/deliveries` — delivery history
- `POST /webhooks/deliveries/:id/retry` — retry failed delivery

## Sidebar

Linked from the admin sidebar under AI Orchestration, between Workflows and Knowledge Base. Icon: `Webhook` from lucide-react.

## Related

- [Scheduling & Webhooks](../orchestration/scheduling.md)
- [Admin API reference](../orchestration/admin-api.md)
