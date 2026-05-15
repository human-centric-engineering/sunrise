/**
 * Admin Orchestration — Approval History
 *
 * GET /api/v1/admin/orchestration/approvals/history
 *
 * Returns the calling admin's historical approval decisions, flattened to
 * one row per decided `human_approval` step. Approvals are derived from
 * `AiWorkflowExecution.executionTrace` — the same source the engine
 * mutates when `executeApproval` / `executeRejection` run — so no schema
 * changes are needed and tokens-only decisions still surface (just
 * without an approver name).
 *
 * Response formats:
 *  - `format=json` (default): paginated `{ data: ApprovalHistoryEntry[], meta }`
 *  - `format=csv`: attachment download, ignores pagination
 *
 * Filters: `decision`, `medium`, `q` (workflow name), `dateFrom`/`dateTo`
 * (decision time). All applied server-side.
 *
 * Authentication: Admin role required.
 */

import type { Prisma } from '@prisma/client';

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { csvEscape } from '@/lib/api/csv';
import { paginatedResponse } from '@/lib/api/responses';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { getRouteLogger } from '@/lib/api/context';
import { approvalHistoryQuerySchema } from '@/lib/validations/orchestration';
import { executionTraceSchema } from '@/lib/validations/orchestration';
import type { ApprovalHistoryEntry, ExecutionTraceEntry } from '@/types/orchestration';

/**
 * Upper bound on executions scanned per request. Each execution can
 * contain multiple approval steps, so the final row count may exceed
 * this — but the prisma scan stays bounded.
 */
const MAX_EXECUTIONS_SCANNED = 1000;
/** Hard cap on CSV export rows to prevent runaway downloads. */
const MAX_CSV_ROWS = 5000;

export const GET = withAdminAuth(async (request, session) => {
  const ip = getClientIP(request);
  const rl = adminLimiter.check(ip);
  if (!rl.success) return createRateLimitResponse(rl);

  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);

  const query = approvalHistoryQuerySchema.parse({
    page: searchParams.get('page') ?? undefined,
    limit: searchParams.get('limit') ?? undefined,
    decision: searchParams.get('decision') ?? undefined,
    medium: searchParams.get('medium') ?? undefined,
    q: searchParams.get('q') ?? undefined,
    dateFrom: searchParams.get('dateFrom') ?? undefined,
    dateTo: searchParams.get('dateTo') ?? undefined,
    format: searchParams.get('format') ?? undefined,
  });

  // Caller-scoped. Pull the smallest reasonable set of executions —
  // anything in a decidable post-pause state — and let the in-memory pass
  // do the JSON walk + decision/medium/date filtering. Prisma JSON
  // filters can't usefully match nested step shapes, so the SQL stage
  // just trims by ownership + status; the in-memory pass does the rest,
  // bounded by `MAX_EXECUTIONS_SCANNED`.
  const where: Prisma.AiWorkflowExecutionWhereInput = {
    userId: session.user.id,
    status: { not: 'paused_for_approval' },
  };

  const executions = await prisma.aiWorkflowExecution.findMany({
    where,
    orderBy: { updatedAt: 'desc' },
    take: MAX_EXECUTIONS_SCANNED,
    select: {
      id: true,
      workflowId: true,
      executionTrace: true,
      workflow: { select: { name: true } },
    },
  });

  // Collect actor user ids up-front so we can hydrate names in one query
  // instead of N. We only resolve `admin:<userId>` actors — token decisions
  // intentionally surface their medium label without a human identity.
  const rows: ApprovalHistoryEntry[] = [];
  const adminUserIds = new Set<string>();

  for (const exec of executions) {
    const parsed = executionTraceSchema.safeParse(exec.executionTrace);
    if (!parsed.success) continue;
    for (const entry of parsed.data as ExecutionTraceEntry[]) {
      if (entry.stepType !== 'human_approval') continue;
      const row = buildHistoryRow(entry, exec.id, exec.workflowId, exec.workflow?.name ?? '—');
      if (!row) continue;
      if (row.medium === 'admin' && row.approverUserId) {
        adminUserIds.add(row.approverUserId);
      }
      rows.push(row);
    }
  }

  // Hydrate approver names for admin decisions. Token decisions stay
  // anonymous by design — the medium chip is the identity.
  const userNameById = new Map<string, string>();
  if (adminUserIds.size > 0) {
    const users = await prisma.user.findMany({
      where: { id: { in: Array.from(adminUserIds) } },
      select: { id: true, name: true, email: true },
    });
    for (const u of users) {
      userNameById.set(u.id, u.name ?? u.email ?? u.id);
    }
  }
  for (const row of rows) {
    if (row.medium === 'admin' && row.approverUserId) {
      row.approverName = userNameById.get(row.approverUserId) ?? null;
    }
  }

  // Apply filters after derivation (decision, medium, q, date range).
  let filtered = rows;
  if (query.decision) filtered = filtered.filter((r) => r.decision === query.decision);
  if (query.medium === 'admin') {
    filtered = filtered.filter((r) => r.medium === 'admin');
  } else if (query.medium === 'token') {
    filtered = filtered.filter((r) => r.medium.startsWith('token-'));
  }
  if (query.q) {
    const needle = query.q.toLowerCase();
    filtered = filtered.filter(
      (r) =>
        r.workflowName.toLowerCase().includes(needle) ||
        r.stepLabel.toLowerCase().includes(needle) ||
        (r.approverName?.toLowerCase().includes(needle) ?? false)
    );
  }
  if (query.dateFrom) {
    const from = query.dateFrom.toISOString();
    filtered = filtered.filter((r) => r.decidedAt >= from);
  }
  if (query.dateTo) {
    const to = query.dateTo.toISOString();
    filtered = filtered.filter((r) => r.decidedAt <= to);
  }
  // Newest decision first; stable per id within the same millisecond.
  filtered.sort((a, b) => {
    if (a.decidedAt === b.decidedAt) return a.id < b.id ? 1 : -1;
    return a.decidedAt < b.decidedAt ? 1 : -1;
  });

  log.info('Approval history fetched', {
    format: query.format ?? 'json',
    scanned: executions.length,
    matched: filtered.length,
  });

  if (query.format === 'csv') {
    const capped = filtered.slice(0, MAX_CSV_ROWS);
    return csvResponse(capped);
  }

  const total = filtered.length;
  const start = (query.page - 1) * query.limit;
  const page = filtered.slice(start, start + query.limit);
  return paginatedResponse(page, { page: query.page, limit: query.limit, total });
});

/**
 * Build a single history row from a `human_approval` trace entry, or
 * return null if the step is still `awaiting_approval` (no decision yet)
 * or has malformed timestamps.
 */
function buildHistoryRow(
  entry: ExecutionTraceEntry,
  executionId: string,
  workflowId: string,
  workflowName: string
): ApprovalHistoryEntry | null {
  if (entry.status !== 'completed' && entry.status !== 'rejected') return null;
  if (!entry.completedAt) return null;
  const decision: 'approved' | 'rejected' = entry.status === 'rejected' ? 'rejected' : 'approved';
  const output = parseApprovalOutput(entry.output);

  const askedAt = entry.startedAt;
  const decidedAt = entry.completedAt;
  const waitDurationMs = Math.max(0, new Date(decidedAt).getTime() - new Date(askedAt).getTime());

  const { medium, approverUserId } = classifyActor(output.actor);

  return {
    id: `${executionId}:${entry.stepId}`,
    executionId,
    workflowId,
    workflowName,
    stepId: entry.stepId,
    stepLabel: entry.label,
    decision,
    medium,
    approverUserId,
    approverName: null,
    actorLabel: output.actor ?? null,
    notes: decision === 'approved' ? (output.notes ?? null) : null,
    reason: decision === 'rejected' ? (output.reason ?? null) : null,
    askedAt,
    decidedAt,
    waitDurationMs,
  };
}

interface ApprovalOutputShape {
  actor?: string | null;
  notes?: string | null;
  reason?: string | null;
}

function parseApprovalOutput(output: unknown): ApprovalOutputShape {
  if (output === null || output === undefined || typeof output !== 'object') return {};
  const raw = output as Record<string, unknown>;
  return {
    actor: typeof raw.actor === 'string' ? raw.actor : null,
    notes: typeof raw.notes === 'string' ? raw.notes : null,
    reason: typeof raw.reason === 'string' ? raw.reason : null,
  };
}

function classifyActor(actor: string | null | undefined): {
  medium: ApprovalHistoryEntry['medium'];
  approverUserId: string | null;
} {
  if (!actor) return { medium: 'unknown', approverUserId: null };
  if (actor.startsWith('admin:')) {
    return { medium: 'admin', approverUserId: actor.slice('admin:'.length) || null };
  }
  if (actor === 'token:chat') return { medium: 'token-chat', approverUserId: null };
  if (actor === 'token:embed') return { medium: 'token-embed', approverUserId: null };
  if (actor.startsWith('token:')) return { medium: 'token-external', approverUserId: null };
  return { medium: 'unknown', approverUserId: null };
}

const CSV_HEADERS = [
  'execution_id',
  'workflow_id',
  'workflow_name',
  'step_id',
  'step_label',
  'decision',
  'medium',
  'approver_name',
  'approver_user_id',
  'actor_label',
  'asked_at',
  'decided_at',
  'wait_seconds',
  'notes',
  'reason',
] as const;

function csvResponse(rows: ApprovalHistoryEntry[]): Response {
  const lines: string[] = [CSV_HEADERS.join(',')];
  for (const r of rows) {
    lines.push(
      [
        csvEscape(r.executionId),
        csvEscape(r.workflowId),
        csvEscape(r.workflowName),
        csvEscape(r.stepId),
        csvEscape(r.stepLabel),
        csvEscape(r.decision),
        csvEscape(r.medium),
        csvEscape(r.approverName ?? ''),
        csvEscape(r.approverUserId ?? ''),
        csvEscape(r.actorLabel ?? ''),
        csvEscape(r.askedAt),
        csvEscape(r.decidedAt),
        csvEscape((r.waitDurationMs / 1000).toFixed(1)),
        csvEscape(r.notes ?? ''),
        csvEscape(r.reason ?? ''),
      ].join(',')
    );
  }
  const stamp = new Date().toISOString().slice(0, 10);
  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="approvals-history-${stamp}.csv"`,
    },
  });
}
