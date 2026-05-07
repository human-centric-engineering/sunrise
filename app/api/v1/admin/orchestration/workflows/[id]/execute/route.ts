/**
 * Admin Orchestration — Execute workflow
 *
 * POST /api/v1/admin/orchestration/workflows/:id/execute
 *
 * Instantiates `OrchestrationEngine` and streams `ExecutionEvent`s back
 * to the client via `sseResponse()`. Platform-agnostic engine code lives
 * in `lib/orchestration/engine/`; this route only handles auth, rate
 * limit, validation, and the SSE bridge.
 *
 * Resume: when the client passes `?resumeFromExecutionId=<cuid>`, the
 * engine continues the named run instead of creating a new row. Used by
 * the `human_approval` flow after the reviewer POSTs to
 * `/executions/:id/approve`.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { sseResponse } from '@/lib/api/sse';
import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import {
  executeWorkflowBodySchema,
  resumeExecutionQuerySchema,
} from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { prepareWorkflowExecution } from '@/app/api/v1/admin/orchestration/workflows/[id]/_shared/execute-helpers';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;

  const body = await validateRequestBody(request, executeWorkflowBodySchema);

  // Query params — resume support.
  const url = new URL(request.url);
  const queryParsed = resumeExecutionQuerySchema.safeParse({
    resumeFromExecutionId: url.searchParams.get('resumeFromExecutionId') ?? undefined,
  });
  if (!queryParsed.success) {
    throw new ValidationError('Invalid query parameters', {
      resumeFromExecutionId: ['Must be a valid CUID'],
    });
  }
  const { resumeFromExecutionId } = queryParsed.data;

  // Resume-path ownership + version pinning. The execution row's `versionId`
  // (stamped at original create time) is the source of truth — if a new
  // version has been published mid-pause, resume must NOT silently switch to
  // the new definition. That would defeat the publish/draft model's whole
  // point. Cross-user resume returns 404 (not 403) so existence isn't leaked.
  let pinnedVersionId: string | null = null;
  if (resumeFromExecutionId) {
    // Short-circuit on malformed workflow id BEFORE the DB lookup so we
    // don't waste a query on a request that can't possibly match.
    const parsedWorkflowId = cuidSchema.safeParse(rawId);
    if (!parsedWorkflowId.success) {
      throw new NotFoundError(`Execution ${resumeFromExecutionId} not found`);
    }
    const existing = await prisma.aiWorkflowExecution.findUnique({
      where: { id: resumeFromExecutionId },
      select: { id: true, userId: true, workflowId: true, versionId: true },
    });
    if (
      !existing ||
      existing.userId !== session.user.id ||
      existing.workflowId !== parsedWorkflowId.data
    ) {
      throw new NotFoundError(`Execution ${resumeFromExecutionId} not found`);
    }
    pinnedVersionId = existing.versionId;
  }

  // Shared pre-flight: ID parse, DB lookup, isActive, definition + DAG + semantic validation.
  // For resumes, prepareWorkflowExecution loads the originally-pinned version
  // (preserving definition continuity across the pause) rather than the
  // workflow's currently-published version.
  const { workflow, definition, version } = await prepareWorkflowExecution(rawId, {
    pinnedVersionId,
  });

  log.info('workflow execute started', {
    workflowId: workflow.id,
    userId: session.user.id,
    budgetLimitUsd: body.budgetLimitUsd,
    resumeFromExecutionId,
  });

  const engine = new OrchestrationEngine();
  const events = engine.execute(
    { id: workflow.id, definition, versionId: version.id },
    body.inputData,
    {
      userId: session.user.id,
      budgetLimitUsd: body.budgetLimitUsd,
      signal: request.signal,
      resumeFromExecutionId,
    }
  );

  return sseResponse(events, { signal: request.signal });
});
