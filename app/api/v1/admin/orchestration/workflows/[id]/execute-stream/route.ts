/**
 * Admin Orchestration — Stream Workflow Execution (SSE)
 *
 * GET /api/v1/admin/orchestration/workflows/:id/execute-stream?inputData=...
 *
 * Alternative to POST /execute for clients that prefer GET-based SSE
 * (EventSource API). Input is passed as a JSON-encoded query param.
 * Events are identical to the POST variant.
 *
 * On client disconnect, execution continues server-side but stops streaming.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { sseResponse } from '@/lib/api/sse';
import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { prepareWorkflowExecution } from '@/app/api/v1/admin/orchestration/workflows/[id]/_shared/execute-helpers';
import { z } from 'zod';

const MAX_INPUT_SIZE = 256 * 1024; // 256 KB

const inputDataSchema = z
  .record(z.string(), z.unknown())
  .refine((val) => JSON.stringify(val).length <= MAX_INPUT_SIZE, {
    message: `inputData must be under ${MAX_INPUT_SIZE / 1024} KB`,
  });

export const GET = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;

  const url = new URL(request.url);
  const inputDataRaw = url.searchParams.get('inputData');
  let inputData: Record<string, unknown> = {};
  if (inputDataRaw) {
    let rawParsed: unknown;
    try {
      rawParsed = JSON.parse(inputDataRaw);
    } catch {
      throw new ValidationError('Invalid inputData', { inputData: ['Must be valid JSON'] });
    }
    const result = inputDataSchema.safeParse(rawParsed);
    if (!result.success) {
      throw new ValidationError('Invalid inputData', { inputData: ['Must be a JSON object'] });
    }
    inputData = result.data;
  }

  const budgetLimitRaw = url.searchParams.get('budgetLimitUsd');
  let budgetLimitUsd: number | undefined;
  if (budgetLimitRaw !== null) {
    const parsed = z.coerce
      .number()
      .positive()
      .max(1000, 'Budget limit must be at most $1,000')
      .safeParse(budgetLimitRaw);
    if (!parsed.success) {
      throw new ValidationError('Invalid budgetLimitUsd', {
        budgetLimitUsd: ['Must be a positive number'],
      });
    }
    budgetLimitUsd = parsed.data;
  }

  // Shared pre-flight: ID parse, DB lookup, isActive, definition + DAG + semantic validation
  const { workflow, definition, version } = await prepareWorkflowExecution(rawId);

  log.info('workflow execute-stream started', {
    workflowId: workflow.id,
    versionId: version.id,
    userId: session.user.id,
  });

  const engine = new OrchestrationEngine();
  const events = engine.execute({ id: workflow.id, definition, versionId: version.id }, inputData, {
    userId: session.user.id,
    budgetLimitUsd,
    signal: request.signal,
  });

  return sseResponse(events, { signal: request.signal });
});
