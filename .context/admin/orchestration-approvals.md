# Orchestration Approval Queue

Admin UI for reviewing, approving, and rejecting paused workflow executions that require human oversight.

> Source of truth: `app/admin/orchestration/approvals/` + `components/admin/orchestration/approvals-table.tsx`. Update this doc when those files change.

## Quick Reference

| What               | Path                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| List page          | `app/admin/orchestration/approvals/page.tsx`                                                   |
| Table component    | `components/admin/orchestration/approvals-table.tsx`                                           |
| Approve endpoint   | `app/api/v1/admin/orchestration/executions/[id]/approve/route.ts`                              |
| Reject endpoint    | `app/api/v1/admin/orchestration/executions/[id]/reject/route.ts`                               |
| Cancel endpoint    | `app/api/v1/admin/orchestration/executions/[id]/cancel/route.ts`                               |
| List endpoint      | `app/api/v1/admin/orchestration/executions/route.ts` (with `?status=paused_for_approval`)      |
| Detail endpoint    | `app/api/v1/admin/orchestration/executions/[id]/route.ts`                                      |
| Validation schemas | `lib/validations/orchestration.ts` (`approveExecutionBodySchema`, `rejectExecutionBodySchema`) |
| Sidebar badge      | `components/admin/admin-sidebar.tsx` (`useApprovalCount`, `injectApprovalBadge`)               |
| Integration tests  | `tests/integration/api/v1/admin/orchestration/executions.id.reject.test.ts`                    |
| Unit tests         | `tests/unit/components/admin/orchestration/approvals-table.test.tsx`                           |

## What admins can do from the UI

- Browse all `paused_for_approval` executions (25 per page).
- Expand a row to see: approval prompt, completed steps, cost summary, input data.
- Approve an execution with optional notes — workflow resumes.
- Reject an execution with a required reason — workflow is cancelled with `"Rejected: <reason>"` in `errorMessage`.
- See pending approval count in the sidebar badge.

## What admins cannot do from the UI (API-only)

- Filter by workflow, date range, or user. The page always shows all pending approvals for the current user.
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

## Anti-patterns

- **Don't add a new list endpoint.** The existing `GET /executions?status=paused_for_approval` is sufficient. Adding a separate `/approvals` endpoint would duplicate query logic.
- **Don't add a new Prisma status for rejection.** Rejection reuses `cancelled` with a prefixed `errorMessage`. Adding `rejected` to the status enum would require a migration and updates to every place that handles status (engine, reaper, SSE events, badges, tables).
- **Don't poll for real-time updates.** The sidebar badge re-fetches on navigation. If real-time is needed later, add SSE or a lightweight polling interval — don't build it preemptively.
