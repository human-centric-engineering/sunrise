# Orchestration Settings Page

Dedicated admin page for global orchestration settings.

**Route:** `/admin/orchestration/settings`

## Page

`app/admin/orchestration/settings/page.tsx` — server component that fetches current settings via `serverFetch(API.ADMIN.ORCHESTRATION.SETTINGS)` and passes them to the client form.

## Component

### `SettingsForm`

`components/admin/orchestration/settings-form.tsx`

Form fields:

| Field                   | Type   | Description                                                              |
| ----------------------- | ------ | ------------------------------------------------------------------------ |
| Input guard mode        | Select | Default prompt injection guard: none, log_only, warn_and_continue, block |
| Global monthly budget   | Number | Platform-wide spend cap in USD. Blank = no cap                           |
| Approval timeout        | Number | How long (ms) to wait for human-in-the-loop approval. Blank = 5 min      |
| Approval default action | Select | What happens on timeout: deny or allow                                   |

All fields use `<FieldHelp>` popovers for contextual help.

**Submit:** PATCHes `API.ADMIN.ORCHESTRATION.SETTINGS` with the form values. Shows success/error banners with 3-second auto-dismiss on success.

## Sidebar

Linked from the admin sidebar at the bottom of the AI Orchestration section. Icon: `Settings` from lucide-react.

## API

`PATCH /api/v1/admin/orchestration/settings` — updates the singleton `AiOrchestrationSettings` row.

## Related

- [Resilience & Error Handling](../orchestration/resilience.md) — guard modes, budget enforcement
- [Streaming Chat Handler](../orchestration/chat.md) — where guard modes are applied
