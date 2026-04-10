/**
 * Admin Orchestration — Single agent (GET / PATCH / DELETE)
 *
 * GET    /api/v1/admin/orchestration/agents/:id
 * PATCH  /api/v1/admin/orchestration/agents/:id
 *   - When `systemInstructions` changes, the previous value is pushed
 *     onto `systemInstructionsHistory` with `{instructions, changedAt, changedBy}`.
 * DELETE /api/v1/admin/orchestration/agents/:id
 *   - Soft delete: sets `isActive = false`. Hard delete would either
 *     cascade conversation/message/cost-log history or fail; soft delete
 *     preserves the audit trail.
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { logger } from '@/lib/logging';
import {
  systemInstructionsHistorySchema,
  updateAgentSchema,
  type SystemInstructionsHistoryEntry,
} from '@/lib/validations/orchestration';
import { cuidSchema } from '@/lib/validations/common';

function parseAgentId(raw: string): string {
  const parsed = cuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid agent id', { id: ['Must be a valid CUID'] });
  }
  return parsed.data;
}

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseAgentId(rawId);

  const agent = await prisma.aiAgent.findUnique({ where: { id } });
  if (!agent) throw new NotFoundError(`Agent ${id} not found`);

  log.info('Agent fetched', { agentId: id });
  return successResponse(agent);
});

export const PATCH = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseAgentId(rawId);

  const current = await prisma.aiAgent.findUnique({ where: { id } });
  if (!current) throw new NotFoundError(`Agent ${id} not found`);

  const body = await validateRequestBody(request, updateAgentSchema);

  // Build the update payload. Only include fields the caller actually sent.
  const data: Prisma.AiAgentUpdateInput = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.slug !== undefined) data.slug = body.slug;
  if (body.description !== undefined) data.description = body.description;
  if (body.model !== undefined) data.model = body.model;
  if (body.provider !== undefined) data.provider = body.provider;
  if (body.providerConfig !== undefined) {
    data.providerConfig = body.providerConfig as Prisma.InputJsonValue;
  }
  if (body.temperature !== undefined) data.temperature = body.temperature;
  if (body.maxTokens !== undefined) data.maxTokens = body.maxTokens;
  if (body.monthlyBudgetUsd !== undefined) data.monthlyBudgetUsd = body.monthlyBudgetUsd;
  if (body.metadata !== undefined) {
    data.metadata = body.metadata as Prisma.InputJsonValue;
  }
  if (body.isActive !== undefined) data.isActive = body.isActive;

  // Audit: if systemInstructions actually changed, push the old value
  // onto the history column before writing the new one.
  if (
    body.systemInstructions !== undefined &&
    body.systemInstructions !== current.systemInstructions
  ) {
    const historyParse = systemInstructionsHistorySchema.safeParse(
      current.systemInstructionsHistory
    );
    if (!historyParse.success) {
      logger.warn('Agent PATCH: systemInstructionsHistory malformed, resetting', {
        agentId: id,
        issues: historyParse.error.issues,
      });
    }
    const history: SystemInstructionsHistoryEntry[] = historyParse.success ? historyParse.data : [];
    history.push({
      instructions: current.systemInstructions,
      changedAt: new Date().toISOString(),
      changedBy: session.user.id,
    });
    data.systemInstructions = body.systemInstructions;
    data.systemInstructionsHistory = history as unknown as Prisma.InputJsonValue;
  }

  try {
    const agent = await prisma.aiAgent.update({ where: { id }, data });

    log.info('Agent updated', {
      agentId: id,
      adminId: session.user.id,
      fieldsChanged: Object.keys(data),
    });

    return successResponse(agent);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ValidationError(`Agent with slug '${body.slug}' already exists`, {
        slug: ['Slug is already in use'],
      });
    }
    throw err;
  }
});

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const id = parseAgentId(rawId);

  const current = await prisma.aiAgent.findUnique({ where: { id } });
  if (!current) throw new NotFoundError(`Agent ${id} not found`);

  const agent = await prisma.aiAgent.update({
    where: { id },
    data: { isActive: false },
  });

  log.info('Agent soft-deleted', {
    agentId: id,
    slug: agent.slug,
    adminId: session.user.id,
  });

  return successResponse({ id, isActive: false });
});
