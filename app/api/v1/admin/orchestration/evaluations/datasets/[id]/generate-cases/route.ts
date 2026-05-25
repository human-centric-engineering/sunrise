/**
 * Admin Orchestration — Synthetic case generation (preview).
 *
 * POST /api/v1/admin/orchestration/evaluations/datasets/:id/generate-cases
 *   Returns LLM-proposed dataset cases for the admin to review BEFORE
 *   they are written. Two modes:
 *     - kb: pull representative chunks from the subject agent's
 *       knowledge and propose grounded cases.
 *     - failure_mining: pull low-scoring prior cases for the subject
 *       agent and propose "similar but harder" variants.
 *
 * The accepted cases are written via the sibling `/commit` route.
 *
 * Genuinely expensive (one LLM call per request). Sub-capped at 10/min
 * via `rate-limit-policy.ts`.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { cuidSchema } from '@/lib/validations/common';
import { generateCasesPreviewSchema } from '@/lib/validations/orchestration-evaluations';
import { generateCases } from '@/lib/orchestration/evaluations/synthesis/case-generator';
import { synthesisLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);

  // Per-flow sub-cap on top of the section-tier limit (the proxy already
  // applied 120/min). Synthesis costs an LLM call, so 10/min/user is
  // the tightening here — mirrors the contact / audio shape.
  const rl = synthesisLimiter.check(session.user.id);
  if (!rl.success) {
    log.warn('Synthesis rate limit exceeded', {
      userId: session.user.id,
      remaining: rl.remaining,
      reset: rl.reset,
    });
    return createRateLimitResponse(rl);
  }

  const { id: rawId } = await params;
  const id = cuidSchema.safeParse(rawId);
  if (!id.success) {
    throw new ValidationError('Invalid dataset id', { id: ['Must be a valid CUID'] });
  }
  const datasetId = id.data;

  const body = await validateRequestBody(request, generateCasesPreviewSchema);

  const dataset = await prisma.aiDataset.findFirst({
    where: { id: datasetId, userId: session.user.id },
    select: { id: true },
  });
  if (!dataset) throw new NotFoundError(`Dataset ${datasetId} not found`);

  // Subject agent ownership: a synthesis run pulls KB chunks / failure
  // seeds from the agent, so the caller must be able to see it. We
  // don't enforce row-level ownership beyond the existence check —
  // agents are global within the admin surface.
  const agent = await prisma.aiAgent.findUnique({
    where: { id: body.agentId },
    select: { id: true },
  });
  if (!agent) throw new NotFoundError(`Agent ${body.agentId} not found`);

  const result = await generateCases({
    agentId: body.agentId,
    userId: session.user.id,
    mode: body.mode,
    count: body.count,
    ...(body.topic ? { topic: body.topic } : {}),
  });

  log.info('Generated synthetic case proposals', {
    datasetId,
    agentId: body.agentId,
    mode: body.mode,
    requested: body.count,
    proposed: result.cases.length,
    costUsd: result.costUsd,
  });
  return successResponse({
    cases: result.cases,
    costUsd: result.costUsd,
    tokenUsage: result.tokenUsage,
  });
});
