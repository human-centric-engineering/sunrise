/**
 * Admin Orchestration — Generate evaluation cases from a description (preview).
 *
 * POST /api/v1/admin/orchestration/evaluations/datasets/generate-from-description
 *   Returns LLM-proposed dataset cases for a subject agent, anchored
 *   only on a free-text domain description plus optional seed inputs.
 *   No KB scoping, no failure-run dependency — this is the cold-start
 *   entry point used from the /datasets/new "Generate" tab.
 *
 *   No dataset row is created at this stage. The admin reviews the
 *   proposed cases and POSTs the accepted set to the sibling
 *   `/commit` route, which creates the dataset + writes the cases
 *   atomically.
 *
 * Genuinely expensive (one LLM call per request). Sub-capped at 10/min
 * via `rate-limit-policy.ts`, mirroring the per-dataset generator.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { generateFromDescriptionPreviewSchema } from '@/lib/validations/orchestration-evaluations';
import { generateCases } from '@/lib/orchestration/evaluations/synthesis/case-generator';
import { synthesisLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';

export const POST = withAdminAuth(async (request, session) => {
  const log = await getRouteLogger(request);

  const rl = synthesisLimiter.check(session.user.id);
  if (!rl.success) {
    log.warn('Synthesis rate limit exceeded (generate-from-description)', {
      userId: session.user.id,
      remaining: rl.remaining,
      reset: rl.reset,
    });
    return createRateLimitResponse(rl);
  }

  const body = await validateRequestBody(request, generateFromDescriptionPreviewSchema);

  // Subject-agent existence check — the generator agent will be invoked
  // with the description; the subject agent is the one cases will run
  // against later, so the operator should pick a real id.
  const agent = await prisma.aiAgent.findUnique({
    where: { id: body.agentId },
    select: { id: true },
  });
  if (!agent) throw new NotFoundError(`Agent ${body.agentId} not found`);

  const result = await generateCases({
    agentId: body.agentId,
    userId: session.user.id,
    mode: 'description',
    count: body.count,
    domainPrompt: body.domainPrompt,
    ...(body.seedInputs && body.seedInputs.length > 0 ? { seedInputs: body.seedInputs } : {}),
  });

  log.info('Generated description-mode case proposals', {
    agentId: body.agentId,
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
