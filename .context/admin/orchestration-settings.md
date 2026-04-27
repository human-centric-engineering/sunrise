# Orchestration Settings Page

Dedicated admin page for global orchestration settings.

**Route:** `/admin/orchestration/settings`

## Page

`app/admin/orchestration/settings/page.tsx` — server component that fetches current settings via `serverFetch(API.ADMIN.ORCHESTRATION.SETTINGS)` and passes them to the client form. Also renders the `BackupPanel` below the form for config export/import.

## Component

### `SettingsForm`

`components/admin/orchestration/settings-form.tsx`

Uses `react-hook-form` + Zod for client-side validation, matching the pattern used in `agent-form.tsx` and `capability-form.tsx`. Organized into six card sections.

### Sections

#### Safety

| Field             | Type   | Description                                                      |
| ----------------- | ------ | ---------------------------------------------------------------- |
| Input guard mode  | Select | Prompt injection guard: none, log_only, warn_and_continue, block |
| Output guard mode | Select | Output filtering guard: none, log_only, warn_and_continue, block |

Agents can override both guard modes in their own configuration. "None" maps to `null` in the database (guard disabled).

#### Limits

| Field                       | Type   | Description                                               |
| --------------------------- | ------ | --------------------------------------------------------- |
| Monthly budget (USD)        | Number | Platform-wide spend cap. Blank = no cap                   |
| Max conversations / user    | Number | Active conversations per user per agent. Blank = no limit |
| Max messages / conversation | Number | Messages per conversation. Blank = no limit               |

#### Retention

| Field                        | Type   | Description                                                              |
| ---------------------------- | ------ | ------------------------------------------------------------------------ |
| Webhook log retention (days) | Number | Auto-cleanup webhook delivery logs. Blank = keep forever. Max 365        |
| Cost log retention (days)    | Number | Auto-cleanup cost logs. Blank = keep forever. Max 365                    |
| Audit log retention (days)   | Number | Auto-cleanup admin audit logs. Blank = keep forever. Max 3650 (10 years) |

#### Approvals

| Field                     | Type   | Description                                          |
| ------------------------- | ------ | ---------------------------------------------------- |
| Approval timeout (ms)     | Number | How long to wait for approval. Blank = 5 min default |
| Default action on timeout | Select | What happens on timeout: deny or allow               |

#### Escalation Routing

| Field                  | Type       | Description                                         |
| ---------------------- | ---------- | --------------------------------------------------- |
| Enable notifications   | Checkbox   | Toggle escalation email/webhook notifications       |
| Notification emails    | Email list | Recipients for escalation alerts (max 20)           |
| Notify on priority     | Select     | Filter: all, medium_and_above, high                 |
| Webhook URL (optional) | URL        | Additional HTTP endpoint for Slack/PagerDuty/custom |

Escalation emails are managed via an inline tag-style list (add/remove) outside of react-hook-form. The form tracks email changes separately for dirty-state detection.

#### Knowledge search

| Field                | Type   | Description                                                           |
| -------------------- | ------ | --------------------------------------------------------------------- |
| Keyword boost weight | Number | Non-positive, reduces cosine distance for keyword matches (-0.2 to 0) |
| Vector weight        | Number | Multiplier for vector similarity (0.1 to 2.0)                         |

Both fields must be provided together or left blank together — partial save sets `searchConfig` to `null`.

All fields use `<FieldHelp>` popovers for contextual help.

**Submit:** PATCHes `API.ADMIN.ORCHESTRATION.SETTINGS` with the form values. Sticky save button with dirty-state tracking (includes escalation email changes) and "Saved" indicator.

### `BackupPanel`

`components/admin/orchestration/settings/backup-panel.tsx`

Renders below the form. Provides config export (JSON download) and import (upload + validate + apply) for orchestration settings, agents, capabilities, and workflows.

## Sidebar

Linked from the admin sidebar at the bottom of the AI Orchestration section. Icon: `Settings` from lucide-react.

## API

`PATCH /api/v1/admin/orchestration/settings` — updates the singleton `AiOrchestrationSettings` row. Accepts all fields as optional; at least one must be provided. Server-side validation via Zod. Invalidates the in-memory settings cache and logs admin audit action.

## Costs page overlap

The Costs Dashboard (`/admin/orchestration/costs`) has its own configuration card for default model assignments and global monthly budget cap. The budget field overlaps with the Settings page — the Costs page links to Settings for the canonical budget control.

## Related

- [Resilience & Error Handling](../orchestration/resilience.md) — guard modes, budget enforcement
- [Streaming Chat Handler](../orchestration/chat.md) — where guard modes and conversation limits are applied
- [Knowledge Base](../orchestration/knowledge.md) — search config tuning
- [Scheduling & Webhooks](../orchestration/scheduling.md) — webhook retention
- [Costs & Budget](orchestration-costs.md) — cost log retention, model defaults
- [Backup & Restore](../orchestration/backup.md) — export/import config
