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
import { prisma } from '@/lib/db/client';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { sseResponse } from '@/lib/api/sse';
import { validateWorkflow } from '@/lib/orchestration/workflows';
import { OrchestrationEngine } from '@/lib/orchestration/engine/orchestration-engine';
import { workflowDefinitionSchema } from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';
import { z } from 'zod';

const inputDataSchema = z.record(z.string(), z.unknown());

export const GET = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid workflow id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

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

  const budgetLimitUsd = url.searchParams.get('budgetLimitUsd');

  const workflow = await prisma.aiWorkflow.findUnique({ where: { id } });
  if (!workflow) throw new NotFoundError(`Workflow ${id} not found`);

  if (!workflow.isActive) {
    throw new ValidationError(`Workflow ${id} is not active`, {
      isActive: ['Workflow must be active before it can be executed'],
    });
  }

  const defParsed = workflowDefinitionSchema.safeParse(workflow.workflowDefinition);
  if (!defParsed.success) {
    throw new ValidationError(`Workflow ${id} has a malformed definition`, {
      workflowDefinition: defParsed.error.issues.map((i) => i.message),
    });
  }
  const definition = defParsed.data;
  const dag = validateWorkflow(definition);
  if (!dag.ok) {
    throw new ValidationError(`Workflow ${id} has a structurally invalid definition`, {
      workflowDefinition: dag.errors,
    });
  }

  log.info('workflow execute-stream started', {
    workflowId: id,
    userId: session.user.id,
  });

  const engine = new OrchestrationEngine();
  const events = engine.executeWithSubscriber({ id: workflow.id, definition }, inputData, {
    userId: session.user.id,
    budgetLimitUsd: budgetLimitUsd ? Number(budgetLimitUsd) : undefined,
    signal: request.signal,
  });

  return sseResponse(events, { signal: request.signal });
});
