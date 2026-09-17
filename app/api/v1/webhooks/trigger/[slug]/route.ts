/**
 * Webhook Trigger — Start a workflow via webhook
 *
 * POST /api/v1/webhooks/trigger/:slug
 *
 * Starts a workflow execution using the request body as input data.
 * The workflow is identified by its slug. Only active workflows can
 * be triggered.
 *
 * Authentication: Bearer token required. The token must be an API key
 * with the `webhook` scope (or `admin`). Create keys via
 * POST /api/v1/user/api-keys with `scopes: ["webhook"]`.
 *
 * Returns the execution ID so the caller can poll for results.
 */

import type { NextRequest } from 'next/server';
import type { Prisma } from '@prisma/client';
import { z } from 'zod';
import { prisma } from '@/lib/db/client';
import { logger } from '@/lib/logging';
import { successResponse, errorResponse } from '@/lib/api/responses';
import { apiKeyChatLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { resolveApiKey, hasScope } from '@/lib/auth/api-keys';
import { runAsOrg } from '@/lib/tenancy/context';
import { enterApiKeyOrg, isOrgRefusal } from '@/lib/tenancy/entry';
import { slugSchema } from '@/lib/validations/common';
import { resolveMaxCostPerExecution } from '@/lib/orchestration/llm/cost-caps';
import { noteMaintenanceWork } from '@/lib/orchestration/maintenance/idle-gate';

const triggerSlugSchema = slugSchema.pipe(z.string().max(100));
const webhookInputSchema = z.record(z.string(), z.unknown());

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<Response> {
  const clientIP = getClientIP(request);

  // Authenticate via API key bearer token
  const resolved = await resolveApiKey(request);
  if (!resolved) {
    return errorResponse('Bearer token required', {
      code: 'UNAUTHORIZED',
      status: 401,
    });
  }
  if (!hasScope(resolved.scopes, 'webhook')) {
    return errorResponse('API key missing required webhook scope', {
      code: 'FORBIDDEN',
      status: 403,
    });
  }

  // Per-API-key rate limit (overrides global default when configured)
  const keyLimit = apiKeyChatLimiter.check(
    `apikey:${resolved.session.user.id}`,
    resolved.rateLimitRpm
  );
  if (!keyLimit.success) return createRateLimitResponse(keyLimit);

  // This route authenticates itself rather than through `withAuth`, so it
  // enters the key's org itself (§106) — the same rule the guards apply, from
  // the same module. An admin key enters none; a refusal names nothing.
  const entry = await enterApiKeyOrg({
    userId: resolved.session.user.id,
    scopes: resolved.scopes,
    orgId: resolved.orgId ?? null,
    owner: { role: resolved.session.user.role, accountType: resolved.ownerAccountType ?? null },
  });
  if (entry && isOrgRefusal(entry)) {
    logger.warn('tenancy: refused to enter an org for a webhook trigger', {
      userId: resolved.session.user.id,
      refused: entry.refused,
    });
    return errorResponse('Access denied', { code: 'FORBIDDEN', status: 403 });
  }

  const trigger = () => triggerWorkflow(request, params, resolved.session.user.id, clientIP);
  return entry
    ? runAsOrg(entry.orgId, trigger, { source: entry.source, role: entry.role })
    : trigger();
}

/** The trigger itself, run inside the key's org scope. */
async function triggerWorkflow(
  request: NextRequest,
  params: Promise<{ slug: string }>,
  userId: string,
  clientIP: string
): Promise<Response> {
  const { slug } = await params;

  if (!triggerSlugSchema.safeParse(slug).success) {
    return errorResponse('Invalid workflow slug format', {
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  }

  const workflow = await prisma.aiWorkflow.findFirst({
    where: { slug, isActive: true },
    select: { id: true, publishedVersionId: true, maxCostPerExecutionUsd: true },
  });

  if (!workflow) {
    return errorResponse('Workflow not found', { code: 'NOT_FOUND', status: 404 });
  }
  if (!workflow.publishedVersionId) {
    return errorResponse('Workflow has no published version', {
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  }

  let inputData: Prisma.InputJsonValue = {};
  try {
    const body: unknown = await request.json();
    const parsed = webhookInputSchema.safeParse(body);
    if (parsed.success) {
      inputData = parsed.data as Prisma.InputJsonValue;
    }
  } catch {
    // Empty body or non-JSON — proceed with empty input
  }

  // Cap resolution for the webhook-triggered run: no caller override,
  // fall through to workflow default then org-wide default. Webhook
  // triggers run as the API key's user but the caller has no path to
  // pass a per-call cap, so the workflow / settings defaults are the
  // only defence against a runaway loop in a webhook-driven workflow.
  const orgSettings = await prisma.aiOrchestrationSettings.findUnique({
    where: { slug: 'global' },
    select: { defaultMaxCostPerExecutionUsd: true },
  });
  const effectiveBudgetLimitUsd = resolveMaxCostPerExecution({
    callerOverride: null,
    workflowDefault: workflow.maxCostPerExecutionUsd,
    settingsDefault: orgSettings?.defaultMaxCostPerExecutionUsd ?? null,
  });

  try {
    const execution = await prisma.aiWorkflowExecution.create({
      data: {
        workflowId: workflow.id,
        versionId: workflow.publishedVersionId,
        status: 'pending',
        inputData,
        executionTrace: [],
        userId,
        ...(effectiveBudgetLimitUsd !== undefined
          ? { budgetLimitUsd: effectiveBudgetLimitUsd }
          : {}),
      },
    });

    // A `pending` execution's recovery sweep is tick-owned, so the idle gate
    // must not be allowed to skip past it (#442).
    noteMaintenanceWork('webhook-trigger-execution');

    logger.info('Webhook triggered workflow execution', {
      workflowSlug: slug,
      workflowId: workflow.id,
      executionId: execution.id,
      clientIP,
    });

    return successResponse(
      {
        executionId: execution.id,
        workflowId: workflow.id,
        workflowSlug: slug,
        status: 'pending',
      },
      undefined,
      { status: 201 }
    );
  } catch (err) {
    logger.error('Webhook trigger failed', err instanceof Error ? err : new Error(String(err)), {
      workflowSlug: slug,
    });
    return errorResponse('Failed to create workflow execution', {
      code: 'INTERNAL_ERROR',
      status: 500,
    });
  }
}
