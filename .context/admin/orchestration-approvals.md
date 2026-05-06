# Orchestration Approval Queue

Admin UI for reviewing, approving, and rejecting paused workflow executions that require human oversight.

> Source of truth: `app/admin/orchestration/approvals/` + `components/admin/orchestration/approvals-table.tsx`. Update this doc when those files change.

## Quick Reference

| What                  | Path                                                                                           |
| --------------------- | ---------------------------------------------------------------------------------------------- |
| List page             | `app/admin/orchestration/approvals/page.tsx`                                                   |
| Table component       | `components/admin/orchestration/approvals-table.tsx`                                           |
| Approve endpoint      | `app/api/v1/admin/orchestration/executions/[id]/approve/route.ts`                              |
| Reject endpoint       | `app/api/v1/admin/orchestration/executions/[id]/reject/route.ts`                               |
| Cancel endpoint       | `app/api/v1/admin/orchestration/executions/[id]/cancel/route.ts`                               |
| List endpoint         | `app/api/v1/admin/orchestration/executions/route.ts` (with `?status=paused_for_approval`)      |
| Detail endpoint       | `app/api/v1/admin/orchestration/executions/[id]/route.ts`                                      |
| Validation schemas    | `lib/validations/orchestration.ts` (`approveExecutionBodySchema`, `rejectExecutionBodySchema`) |
| Shared actions        | `lib/orchestration/approval-actions.ts` (`executeApproval`, `executeRejection`)                |
| Approval tokens       | `lib/orchestration/approval-tokens.ts` (HMAC token generate/verify/URL builder)                |
| Notification dispatch | `lib/orchestration/notifications/dispatcher.ts` (channel routing for external notifications)   |
| Token approve route   | `app/api/v1/orchestration/approvals/[id]/approve/route.ts` (public, token-auth)                |
| Token reject route    | `app/api/v1/orchestration/approvals/[id]/reject/route.ts` (public, token-auth)                 |
| Sidebar badge         | `components/admin/admin-sidebar.tsx` (`useApprovalCount`, `injectApprovalBadge`)               |
| Integration tests     | `tests/integration/api/v1/admin/orchestration/executions.id.{approve,reject}.test.ts`          |
| Token endpoint tests  | `tests/integration/api/v1/orchestration/approvals.id.{approve,reject}.test.ts`                 |
| Unit tests            | `tests/unit/components/admin/orchestration/approvals-table.test.tsx`                           |

## What admins can do from the UI

- Browse all `paused_for_approval` executions (25 per page).
- Expand a row to see: approval prompt, completed steps, cost summary, input data.
- Approve an execution with optional notes — workflow resumes.
- Reject an execution with a required reason — workflow is cancelled with `"Rejected: <reason>"` in `errorMessage`.
- See pending approval count in the sidebar badge.

## What admins cannot do from the UI (API-only)

- Filter by workflow, date range, or user. The page shows pending approvals for executions owned by the current admin. Delegated approvers cannot see executions they are authorised to approve in this list — they must use the notification link or direct URL.
- View delegated approvals in the queue (the list endpoint scopes to execution ownership, not approver authorisation).
- Bulk approve/reject multiple executions at once.
- Resume a rejected execution (cancellation is final).

## List View

Route: `/admin/orchestration/approvals`.

Server component page fetches `GET /executions?status=paused_for_approval&limit=25` via `serverFetch`. Failures degrade to an empty list with a logged error, not a thrown 500.

Client-side state lives in `ApprovalsTable`.

### Columns

| Column    | Source                    | Notes                                            |
| --------- | ------------------------- | ------------------------------------------------ |
| (expand)  | chevron icon              | Click row to expand/collapse detail              |
| Workflow  | `item.workflow.name`      | Links to workflow detail page                    |
| Execution | `item.id` (truncated)     | First 8 chars + `...`, links to execution detail |
| Paused    | `item.createdAt`          | Formatted date                                   |
| Waiting   | computed from `createdAt` | Relative duration (e.g. `2h 14m`, `3d 5h`)       |
| Actions   | Approve / Reject buttons  | Open confirmation dialogs                        |

### Empty state

"No executions awaiting approval." with a link to the general executions list.

## Expand View

Clicking a row fetches `GET /executions/:id` on demand and displays:

1. **Approval prompt** — extracted from the `awaiting_approval` trace entry's `output.prompt` field. Shown in an amber-highlighted box.
2. **Cost summary** — tokens used, cost in USD, budget limit (if set).
3. **Previous steps** — trace entries before the approval step, showing step type badge, label, and duration.
4. **Input data** — collapsible JSON view of `execution.inputData`.

## Approve / Reject Actions

### Approve

- Opens `AlertDialog` with optional notes textarea.
- `POST /executions/:id/approve` with `{ notes?: string }`.
- Sets execution status to `pending` (engine resumes on client reconnect).
- Row is removed from the table on success.

### Reject

- Opens `AlertDialog` with required reason textarea.
- `POST /executions/:id/reject` with `{ reason: string }` (1-5000 chars).
- Sets execution status to `cancelled`, `errorMessage: "Rejected: <reason>"`, `completedAt` to now.
- Optimistic lock prevents concurrent approve+reject races.
- Row is removed from the table on success.

### Reject vs Cancel

Both result in `status: cancelled`, but:

- **Cancel** (`POST /executions/:id/cancel`): An abort — no reason required, works on `running` or `paused_for_approval`.
- **Reject** (`POST /executions/:id/reject`): A deliberate review decision — reason required, only works on `paused_for_approval`, `errorMessage` prefixed with `"Rejected: "`.

No new Prisma status was added. The UI can distinguish rejection from cancellation by checking `errorMessage?.startsWith('Rejected: ')`.

## Sidebar Badge

The sidebar's "Operate" subgroup shows an orange badge count next to "Approval Queue" when pending approvals exist.

Implementation: `useApprovalCount` hook in `admin-sidebar.tsx` fetches `GET /executions?status=paused_for_approval&limit=1` and reads `meta.total`. Re-fetches on each pathname change (navigation). Count is stale-on-load — no polling or SSE.

## External Approval Channels

The approval system supports approvals from external channels (Slack, email, WhatsApp, SMS) via stateless HMAC-signed tokens. No database migration was needed.

### How it works

1. **Execution pauses** — A `human_approval` step runs and throws `PausedForApproval`.
2. **Engine emits events** — `pauseForApproval()` generates signed approval/rejection URLs, then emits:
   - `workflow.paused_for_approval` hook event (with URLs, channel metadata, approver list)
   - `approval_required` webhook event (same payload)
   - Notification dispatch log (via `dispatchApprovalNotification`)
3. **External system delivers** — A webhook consumer (e.g., Slack bot, email sender) receives the event and posts the approve/reject URLs to the target channel.
4. **Recipient clicks URL** — The signed URL hits the public token-authenticated endpoint, which verifies the HMAC token and calls the shared approval action.

### Token design

Tokens are stateless HMAC-SHA256 signatures using `BETTER_AUTH_SECRET`:

- Format: `base64url(payload).base64url(HMAC-SHA256(secret, payloadJSON))`
- Payload: `{ executionId, action, expiresAt }`
- Default expiry: 7 days (overridden by step's `timeoutMinutes`)
- Verified with constant-time comparison (`timingSafeEqual`)
- No token table, no cleanup job, no migration

### Step config for external channels

```jsonc
{
  "type": "human_approval",
  "config": {
    "prompt": "Review the generated report before publishing",
    "notificationChannel": "slack", // string shorthand
    // OR:
    "notificationChannel": {
      // object form
      "type": "slack",
      "target": "#approvals",
      "metadata": { "urgency": "high" },
    },
    "timeoutMinutes": 1440, // token expiry (24h)
    "approverUserIds": ["cuid1", "cuid2"], // optional delegation
  },
}
```

### Approver scoping

By default only the execution owner can approve/reject via the admin endpoints. Adding `approverUserIds` to the step config enables delegated approval:

- **Admin endpoints**: Allow access if `session.user.id` matches `execution.userId` (owner) OR is in the `approverUserIds` list from the trace's `awaiting_approval` output entry.
- **Token endpoints**: Token is the authorization — anyone with a valid unexpired token can act. No ownership check.
- Non-authorized admin users receive 404 (not 403) to avoid confirming existence.

## Trace Entry Output Shape

When an execution pauses for approval, the engine writes an `awaiting_approval` trace entry. Approval or rejection updates that entry in place. The output shape varies by action:

### Approval (default path)

When the client sends `{}` or `{ notes: "..." }` (no `approvalPayload`), the shared action writes:

```json
{
  "approved": true,
  "notes": "Looks good" | null,
  "actor": "admin:cuid123" | "token:external"
}
```

Trace entry status transitions: `awaiting_approval` → `completed`.

### Approval (custom payload)

When the client sends `{ approvalPayload: { ... } }`, the payload **replaces** the entire output — `actor` and `notes` are **not** included. Use this only when the consuming step needs structured approval data. The admin UI and approval queue table do **not** use custom payloads (they send `{}`).

### Rejection

```json
{
  "rejected": true,
  "reason": "Does not meet compliance requirements",
  "actor": "admin:cuid123" | "token:external"
}
```

Trace entry status transitions: `awaiting_approval` → `rejected`. The `rejected` status is distinct from `failed` and `skipped` — it indicates a deliberate human decision, not a system error.

Additionally, the execution record gets:

- `status: "cancelled"`
- `errorMessage: "Rejected: <reason>"`
- `completedAt: <now>`

### Distinguishing rejection from cancellation

Both result in `status: cancelled` on the execution. To tell them apart:

- **In the trace**: A rejection has a trace entry with `status: "rejected"`. A cancellation leaves the `awaiting_approval` entry unchanged.
- **In errorMessage**: Rejection prefixes the reason with `"Rejected: "`. Cancellation has no error message (or a generic one).

### Actor format

The `actor` field follows the pattern `<source>:<identifier>`:

- `admin:<userId>` — admin dashboard approval/rejection
- `token:external` — public token endpoint (email / Slack / non-browser caller)
- `token:chat` — channel-specific sub-route hit from the admin chat surface (`…/approve/chat`, `…/reject/chat`)
- `token:embed` — channel-specific sub-route hit from the embed widget (`…/approve/embed`, `…/reject/embed`)

## Chat-rendered approvals

When an agent runs a workflow via the `run_workflow` capability and that workflow pauses on a `human_approval` step, the pause surfaces inline in the chat conversation as an Approve / Reject card — both on the admin chat surface and inside the embed widget — instead of the user having to wait for an admin to clear the queue.

| What                        | Where                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| New SSE ChatEvent variant   | `approval_required` in `types/orchestration.ts:ChatEvent`                                               |
| Pending-approval shape      | `PendingApproval` interface in `types/orchestration.ts`; persisted on `MessageMetadata.pendingApproval` |
| Streaming-handler emit site | `lib/orchestration/chat/streaming-handler.ts:extractPendingApproval`                                    |
| Admin chat card             | `components/admin/orchestration/chat/approval-card.tsx`                                                 |
| Embed widget card           | `app/api/v1/embed/widget.js/route.ts:renderApprovalCard`                                                |
| Channel-specific approve    | `app/api/v1/orchestration/approvals/[id]/{approve,reject}/{chat,embed}/route.ts`                        |
| Status polling endpoint     | `app/api/v1/orchestration/approvals/[id]/status/route.ts`                                               |
| Shared route helper         | `lib/orchestration/approval-route-helpers.ts`                                                           |
| Embed origin allowlist      | `OrchestrationSettings.embedAllowedOrigins` (Json column on the singleton row)                          |

The chat card hits the channel-specific sub-route with the matching HMAC token; on a 200 it polls `GET /approvals/:id/status` (token-authenticated, permissive CORS) until the workflow reaches a terminal state, then synthesises a follow-up user message carrying the workflow output so the LLM gets a fresh turn to summarise.

The `actorLabel` is **route-pinned**, never trusted from a body field — a leaked HMAC token can't be replayed under a misleading channel label in audit logs. CORS posture differs per channel: same-origin only for `/chat` (rejects `null` Origin), allowlist (`embedAllowedOrigins`) for `/embed`, none for the legacy `/approve` and `/reject` routes that serve email and Slack callers.

See [Streaming Chat — In-chat approvals](../orchestration/chat.md#in-chat-approvals) for the SSE event sequence, and [Embed Widget](../orchestration/embed.md) for the partner-site setup.

## Anti-patterns

- **Don't add a new list endpoint.** The existing `GET /executions?status=paused_for_approval` is sufficient. Adding a separate `/approvals` endpoint would duplicate query logic.
- **Don't add a new Prisma status for rejection.** Rejection reuses `cancelled` with a prefixed `errorMessage`. Adding `rejected` to the status enum would require a migration and updates to every place that handles status (engine, reaper, SSE events, badges, tables).
- **Don't poll for real-time updates.** The sidebar badge re-fetches on navigation. If real-time is needed later, add SSE or a lightweight polling interval — don't build it preemptively.
- **Don't store approval tokens in the database.** Tokens are stateless HMAC signatures verified on the fly. Adding a token table would add migration complexity and cleanup jobs for no benefit.
- **Don't build channel-specific SDKs into the app.** The notification dispatcher includes channel metadata in webhook payloads. Actual delivery (Slack API, SendGrid, Twilio) is handled by external webhook consumers.
- **Don't trust an `actorLabel` body field from the client.** The chat-rendered approval card and the embed widget POST through their own sub-routes (`…/approve/chat`, `…/approve/embed`); the server pins the actor on the route itself. A body field would be theatre — anyone with the HMAC token can claim any value.
- **Don't widen CORS on the legacy `/approve` and `/reject` routes.** They exist for non-browser callers (email links, Slack) and have no CORS by design. Use the channel-specific sub-routes for any browser-originated approval flow.
