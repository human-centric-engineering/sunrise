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
import { sseResponse } from '@/lib/api/sse';
import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import {
  executeWorkflowBodySchema,
  resumeExecutionQuerySchema,
} from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { adminCanViewExecution } from '@/lib/orchestration/access/execution-access';
import {
  prepareWorkflowExecution,
  resolveEffectiveExecutionCap,
} from '@/app/api/v1/admin/orchestration/workflows/[id]/_shared/execute-helpers';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
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
  // point. Another admin's own run returns 404 (not 403) so existence isn't
  // leaked; a system-owned run (schedule/inbound, `userId = null`) is
  // resumable by any admin the authorization policy permits an unattributed
  // read — every admin on a default install, because otherwise a scheduled
  // run that pauses at an approval gate could be approved but never
  // continued, and would sit in `pending` forever. See
  // `lib/orchestration/access/execution-access.ts`.
  let pinnedVersionId: string | null = null;
  let resumeOwnerUserId: string | null = null;
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
      !adminCanViewExecution(existing, session) ||
      existing.workflowId !== parsedWorkflowId.data
    ) {
      throw new NotFoundError(`Execution ${resumeFromExecutionId} not found`);
    }
    pinnedVersionId = existing.versionId;
    resumeOwnerUserId = existing.userId;
  }

  // Shared pre-flight: ID parse, DB lookup, isActive, definition + DAG + semantic validation.
  // For resumes, prepareWorkflowExecution loads the originally-pinned version
  // (preserving definition continuity across the pause) rather than the
  // workflow's currently-published version.
  const { workflow, definition, version } = await prepareWorkflowExecution(rawId, {
    pinnedVersionId,
  });

  // Cap resolution: caller override > AiWorkflow.maxCostPerExecutionUsd >
  // AiOrchestrationSettings.defaultMaxCostPerExecutionUsd > undefined.
  // The resolved value is what the engine actually enforces and what
  // gets persisted onto AiWorkflowExecution.budgetLimitUsd for resume
  // / reaper continuity.
  const effectiveBudgetLimitUsd = await resolveEffectiveExecutionCap({
    callerOverride: body.budgetLimitUsd,
    workflowDefault: workflow.maxCostPerExecutionUsd,
  });

  log.info('workflow execute started', {
    workflowId: workflow.id,
    userId: session.user.id,
    callerBudgetLimitUsd: body.budgetLimitUsd ?? null,
    workflowMaxCostPerExecutionUsd: workflow.maxCostPerExecutionUsd ?? null,
    effectiveBudgetLimitUsd: effectiveBudgetLimitUsd ?? null,
    resumeFromExecutionId,
  });

  // A resumed run keeps the user context it was created with, exactly as it
  // keeps its pinned `versionId` and persisted `scope`. Handing the resuming
  // admin's id to a system-owned run would give its second half a user
  // context its first half never had — `judge_call` would start filing a
  // stranger's transcript into that admin's history, and `user_memory` would
  // read their remembered facts from inbound traffic. For an owner-resume
  // this is the session id either way.
  const engine = new OrchestrationEngine();
  const events = engine.execute(
    { id: workflow.id, definition, versionId: version.id },
    body.inputData,
    {
      userId: resumeFromExecutionId ? resumeOwnerUserId : session.user.id,
      ...(effectiveBudgetLimitUsd !== undefined ? { budgetLimitUsd: effectiveBudgetLimitUsd } : {}),
      ...(body.scope ? { scope: body.scope } : {}),
      signal: request.signal,
      resumeFromExecutionId,
    }
  );

  return sseResponse(events, { signal: request.signal });
});
