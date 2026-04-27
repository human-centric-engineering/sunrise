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
import { apiLimiter, apiKeyChatLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { resolveApiKey, hasScope } from '@/lib/auth/api-keys';
import { slugSchema } from '@/lib/validations/common';

const SYSTEM_USER_ID = 'webhook-trigger';

const triggerSlugSchema = slugSchema.pipe(z.string().max(100));
const webhookInputSchema = z.record(z.string(), z.unknown());

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
): Promise<Response> {
  const clientIP = getClientIP(request);
  const rateLimit = apiLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

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

  const { slug } = await params;

  if (!triggerSlugSchema.safeParse(slug).success) {
    return errorResponse('Invalid workflow slug format', {
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  }

  const workflow = await prisma.aiWorkflow.findFirst({
    where: { slug, isActive: true },
  });

  if (!workflow) {
    return errorResponse('Workflow not found', { code: 'NOT_FOUND', status: 404 });
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

  try {
    const execution = await prisma.aiWorkflowExecution.create({
      data: {
        workflowId: workflow.id,
        status: 'pending',
        inputData,
        executionTrace: [],
        userId: SYSTEM_USER_ID,
      },
    });

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
