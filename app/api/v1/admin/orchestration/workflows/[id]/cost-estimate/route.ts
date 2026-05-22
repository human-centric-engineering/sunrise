/**
 * Admin Orchestration — Workflow cost estimate
 *
 * GET /api/v1/admin/orchestration/workflows/:id/cost-estimate
 *   ?itemCount=N&supervisor=true|false
 *     Estimates against the workflow's *published* version. Trigger UIs
 *     (audit models, rerun execution) call this — the published snapshot
 *     is what would actually run.
 *
 * POST /api/v1/admin/orchestration/workflows/:id/cost-estimate
 *   Body: { definition, itemCount?, supervisor? }
 *     Estimates against an *in-memory* definition. The workflow builder
 *     calls this with the draft on the canvas so the banner / node
 *     tinting reflect unsaved edits. Past-run calibration still keys by
 *     workflowId so empirical mode reuses historical token shapes.
 *
 * Both responses include `effectiveCapUsd` — the per-execution cap that
 * would apply to a run started without an explicit caller override.
 * Resolution order: workflow > org default > null (no cap).
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
import {
  estimateWorkflowCost,
  type WorkflowCostEstimate,
} from '@/lib/orchestration/cost-estimation/workflow-cost';
import { resolveMaxCostPerExecution } from '@/lib/orchestration/llm/cost-caps';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';

const querySchema = z.object({
  itemCount: z.coerce.number().int().min(0).max(10_000).optional(),
  supervisor: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

const postBodySchema = z.object({
  definition: workflowDefinitionSchema,
  itemCount: z.number().int().min(0).max(10_000).optional(),
  supervisor: z.boolean().optional(),
});

interface WorkflowCostEstimateResponse extends WorkflowCostEstimate {
  /**
   * Effective per-execution cap in USD (workflow override > org default).
   * Null = no cap configured at either layer; only the monthly budget
   * applies. The builder uses this to colour the banner and tint nodes.
   */
  effectiveCapUsd: number | null;
}

async function resolveEffectiveCap(workflowId: string): Promise<number | null> {
  const [workflow, settings] = await Promise.all([
    prisma.aiWorkflow.findUnique({
      where: { id: workflowId },
      select: { maxCostPerExecutionUsd: true },
    }),
    prisma.aiOrchestrationSettings.findUnique({
      where: { slug: 'global' },
      select: { defaultMaxCostPerExecutionUsd: true },
    }),
  ]);
  return (
    resolveMaxCostPerExecution({
      callerOverride: null,
      workflowDefault: workflow?.maxCostPerExecutionUsd ?? null,
      settingsDefault: settings?.defaultMaxCostPerExecutionUsd ?? null,
    }) ?? null
  );
}

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

  const [estimate, effectiveCapUsd] = await Promise.all([
    estimateWorkflowCost({
      workflowId: id,
      itemCount: queryParsed.data.itemCount,
      supervisor: queryParsed.data.supervisor,
    }),
    resolveEffectiveCap(id),
  ]);

  log.info('Workflow cost estimate computed', {
    workflowId: id,
    itemCount: queryParsed.data.itemCount,
    supervisor: queryParsed.data.supervisor,
    basedOn: estimate.basedOn,
    sampleSize: estimate.sampleSize,
    midUsd: estimate.midUsd,
    effectiveCapUsd,
  });

  const response: WorkflowCostEstimateResponse = { ...estimate, effectiveCapUsd };
  return successResponse(response);
});

/**
 * Estimate against an in-memory definition. The workflow builder calls
 * this on every (debounced) edit so the banner and per-node tinting
 * reflect the live draft, not the last-published snapshot.
 */
export const POST = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    throw new ValidationError('Invalid JSON body');
  }
  const bodyParsed = postBodySchema.safeParse(body);
  if (!bodyParsed.success) {
    throw new ValidationError(
      'Invalid request body',
      bodyParsed.error.flatten().fieldErrors as Record<string, string[]>
    );
  }

  const workflow = await prisma.aiWorkflow.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!workflow) throw new NotFoundError(`Workflow ${id} not found`);

  const [estimate, effectiveCapUsd] = await Promise.all([
    estimateWorkflowCost({
      workflowId: id,
      itemCount: bodyParsed.data.itemCount,
      supervisor: bodyParsed.data.supervisor,
      definition: bodyParsed.data.definition,
    }),
    resolveEffectiveCap(id),
  ]);

  log.info('Workflow cost estimate computed (draft)', {
    workflowId: id,
    itemCount: bodyParsed.data.itemCount,
    supervisor: bodyParsed.data.supervisor,
    basedOn: estimate.basedOn,
    sampleSize: estimate.sampleSize,
    midUsd: estimate.midUsd,
    effectiveCapUsd,
  });

  const response: WorkflowCostEstimateResponse = { ...estimate, effectiveCapUsd };
  return successResponse(response);
});
