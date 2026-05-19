/**
 * Admin Orchestration — Rerun execution
 *
 * POST /api/v1/admin/orchestration/executions/:id/rerun
 *
 * Creates a fresh `AiWorkflowExecution` row that runs the original
 * execution's `inputData` against either the workflow's current
 * published version or a caller-specified version. Streams
 * `ExecutionEvent`s via SSE so the client can navigate to the new
 * execution as soon as `workflow_started` arrives with the new id.
 *
 * Body (all fields optional):
 *   - `versionId` — pin the rerun to a specific AiWorkflowVersion id.
 *     The version must belong to the same workflow. When omitted, the
 *     workflow's current `publishedVersionId` is used (matches the
 *     "fix-and-rerun" common case).
 *   - `budgetLimitUsd` — override the original's budget. When omitted,
 *     the original execution's budget is reused (preserves "same
 *     input parameters" semantics).
 *
 * Lineage: the new execution row is created with
 * `parentExecutionId` set to the original's id, so the detail view
 * can render a "Re-run of execution X" breadcrumb.
 *
 * Authorization: admin role required. The original execution must
 * belong to the same user (`session.user.id`) — cross-user reruns
 * return 404 (not 403) so existence isn't leaked.
 */

import { z } from 'zod';

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { sseResponse } from '@/lib/api/sse';
import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import { rerunExecutionBodySchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { prepareWorkflowExecution } from '@/app/api/v1/admin/orchestration/workflows/[id]/_shared/execute-helpers';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;

  // Short-circuit on a malformed id before any DB lookup. Returning 404
  // (not 400) matches how cross-user requests are handled — existence
  // is never leaked through error-code differences.
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new NotFoundError(`Execution ${rawId} not found`);
  }
  const originalId = parsed.data;

  const body = await validateRequestBody(request, rerunExecutionBodySchema);

  // Load the original execution. Scope ownership at the query — a
  // cross-user id resolves to null and surfaces as 404, not 403.
  const original = await prisma.aiWorkflowExecution.findFirst({
    where: { id: originalId, userId: session.user.id },
    select: {
      id: true,
      workflowId: true,
      inputData: true,
      budgetLimitUsd: true,
      versionId: true,
    },
  });
  if (!original) {
    throw new NotFoundError(`Execution ${originalId} not found`);
  }

  // Validate the caller-specified versionId before kicking off any work.
  // The version must belong to THIS workflow — cross-workflow pins are
  // rejected at `prepareWorkflowExecution`, but catching here gives the
  // operator a clearer error (versionId on the rerun body vs. "workflow
  // has no version with id" deep in the helper).
  if (body.versionId) {
    const version = await prisma.aiWorkflowVersion.findFirst({
      where: { id: body.versionId, workflowId: original.workflowId },
      select: { id: true },
    });
    if (!version) {
      throw new ValidationError(`Version ${body.versionId} does not belong to this workflow`, {
        versionId: ['Must reference an AiWorkflowVersion of the same workflow'],
      });
    }
  }

  // Shared pre-flight: load + validate the chosen version's snapshot.
  // When body.versionId is absent, prepareWorkflowExecution falls back
  // to the workflow's current publishedVersionId.
  const { workflow, definition, version } = await prepareWorkflowExecution(original.workflowId, {
    pinnedVersionId: body.versionId ?? null,
  });

  // `inputData` is `Json` on the row — Prisma's runtime shape for that
  // column is `JsonValue`. Zod-parse it before handing to the engine so a
  // stored string / number / array / null surfaces as a clear validation
  // error instead of an unexpected shape downstream.
  const inputData = z.record(z.string(), z.unknown()).parse(original.inputData ?? {});

  // Budget: caller override wins; else preserve the original's value.
  // null on the original means "no limit" which the engine treats by
  // skipping the budget check entirely.
  const budgetLimitUsd = body.budgetLimitUsd ?? original.budgetLimitUsd ?? undefined;

  log.info('execution rerun started', {
    workflowId: workflow.id,
    originalExecutionId: original.id,
    versionId: version.id,
    versionNumber: version.version,
    userId: session.user.id,
    budgetLimitUsd,
    customVersionPin: body.versionId !== undefined,
  });

  const engine = new OrchestrationEngine();
  const events = engine.execute({ id: workflow.id, definition, versionId: version.id }, inputData, {
    userId: session.user.id,
    budgetLimitUsd,
    signal: request.signal,
    parentExecutionId: original.id,
  });

  return sseResponse(events, { signal: request.signal });
});
