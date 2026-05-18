/**
 * Admin Orchestration — Workflow cost estimate
 *
 * GET /api/v1/admin/orchestration/workflows/:id/cost-estimate
 *   ?itemCount=N&supervisor=true|false
 *
 * Returns a planning-grade USD estimate for running the workflow with
 * the supplied parameters. Generic across all workflows — the
 * heuristic auto-derives from the published workflow definition
 * (LLM-producing step count + presence of a supervisor step), and the
 * empirical path uses past completed executions of *this* workflow.
 *
 * Consumed by the Audit Models dialog (which passes `itemCount` =
 * selected model count). Any other trigger UI can call the same
 * endpoint — pass `itemCount=0` (or omit) for workflows whose cost
 * doesn't scale with an input list.
 *
 * See `lib/orchestration/cost-estimation/workflow-cost.ts` for the
 * methodology and `.context/orchestration/cost-estimation.md` for the
 * full guide.
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { estimateWorkflowCost } from '@/lib/orchestration/cost-estimation/workflow-cost';

const querySchema = z.object({
  itemCount: z.coerce.number().int().min(0).max(10_000).optional(),
  supervisor: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const idParsed = cuidSchema.safeParse(rawId);
  if (!idParsed.success) {
    throw new ValidationError('Invalid workflow id', { id: ['Must be a valid CUID'] });
  }
  const id = idParsed.data;

  const { searchParams } = new URL(request.url);
  const queryParsed = querySchema.safeParse({
    itemCount: searchParams.get('itemCount') ?? undefined,
    supervisor: searchParams.get('supervisor') ?? undefined,
  });
  if (!queryParsed.success) {
    throw new ValidationError(
      'Invalid query parameters',
      queryParsed.error.flatten().fieldErrors as Record<string, string[]>
    );
  }

  const workflow = await prisma.aiWorkflow.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!workflow) throw new NotFoundError(`Workflow ${id} not found`);

  const estimate = await estimateWorkflowCost({
    workflowId: id,
    itemCount: queryParsed.data.itemCount,
    supervisor: queryParsed.data.supervisor,
  });

  log.info('Workflow cost estimate computed', {
    workflowId: id,
    itemCount: queryParsed.data.itemCount,
    supervisor: queryParsed.data.supervisor,
    basedOn: estimate.basedOn,
    sampleSize: estimate.sampleSize,
    midUsd: estimate.midUsd,
  });

  return successResponse(estimate);
});
