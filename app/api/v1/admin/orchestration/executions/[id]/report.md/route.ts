/**
 * Admin Orchestration — Execution report (on-demand)
 *
 * GET /api/v1/admin/orchestration/executions/:id/report.md
 *
 * Returns a deterministic Markdown report of the execution + trace,
 * suitable for download. Independent of whether the workflow has a
 * `report` step in its DAG — the renderer reads the persisted trace.
 *
 * Includes the supervisor verdict block when present.
 *
 * Ownership: the caller's own runs, plus system-owned runs (`userId = null`
 * — schedule- and inbound-triggered) where the authorization policy permits
 * an unattributed read, which a default install does. Another admin's own run
 * returns 404 (not 403) — we never confirm existence of a row the caller
 * cannot see.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/api/errors';
import { logger } from '@/lib/logging';
import { cuidSchema } from '@/lib/validations/common';
import { adminCanViewExecution } from '@/lib/orchestration/access/execution-access';
import { executionTraceSchema, supervisorReportSchema } from '@/lib/validations/orchestration';
import {
  renderExecutionMarkdown,
  type RenderExecutionInfo,
} from '@/lib/orchestration/trace/render-markdown';
import { WorkflowStatus } from '@/types/orchestration';

/**
 * Terminal statuses on which a report can safely be rendered. A running
 * or paused-for-approval execution would produce a half-finished
 * Markdown that looks complete but reflects only the steps so far —
 * worse than no report. Block with 409.
 */
const TERMINAL_STATUSES = new Set<string>([
  WorkflowStatus.COMPLETED,
  WorkflowStatus.FAILED,
  WorkflowStatus.CANCELLED,
]);

export const GET = withAdminAuth<{ id: string }>(async (_request, session, { params }) => {
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid execution id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const execution = await prisma.aiWorkflowExecution.findUnique({
    where: { id },
    include: { workflow: { select: { name: true } } },
  });
  if (!execution || !adminCanViewExecution(execution, session)) {
    throw new NotFoundError(`Execution ${id} not found`);
  }

  if (!TERMINAL_STATUSES.has(execution.status)) {
    throw new ConflictError(
      `Execution is ${execution.status}. Reports are only generated for terminal executions (completed, failed, or cancelled).`
    );
  }

  const trace = executionTraceSchema.parse(execution.executionTrace);

  // Validate the persisted supervisorReport JSON against the shared
  // schema. On parse failure (legacy row, hand-edit, mid-deploy drift)
  // we log and pass `null` so the renderer omits the supervisor block
  // rather than crashing on a missing required field.
  let supervisorReport = null;
  if (execution.supervisorReport !== null) {
    const reportParsed = supervisorReportSchema.safeParse(execution.supervisorReport);
    if (reportParsed.success) {
      supervisorReport = reportParsed.data;
    } else {
      logger.warn('report.md: supervisorReport failed schema validation, omitting block', {
        executionId: id,
        issues: reportParsed.error.issues.length,
      });
    }
  }

  const renderInfo: RenderExecutionInfo = {
    id: execution.id,
    workflowId: execution.workflowId,
    workflowName: execution.workflow.name,
    status: execution.status,
    totalTokensUsed: execution.totalTokensUsed,
    totalCostUsd: execution.totalCostUsd,
    startedAt: execution.startedAt?.toISOString() ?? null,
    completedAt: execution.completedAt?.toISOString() ?? null,
    createdAt: execution.createdAt.toISOString(),
    inputData: execution.inputData,
    outputData: execution.outputData,
    errorMessage: execution.errorMessage,
    supervisorVerdict: execution.supervisorVerdict,
    supervisorScore: execution.supervisorScore,
    supervisorReport,
    supervisorReviewedAt: execution.supervisorReviewedAt?.toISOString() ?? null,
  };

  const markdown = renderExecutionMarkdown(renderInfo, trace);

  return new Response(markdown, {
    status: 200,
    headers: {
      'Content-Type': 'text/markdown; charset=utf-8',
      'Content-Disposition': `attachment; filename="execution-${id}.md"`,
      'Cache-Control': 'no-store',
    },
  });
});
