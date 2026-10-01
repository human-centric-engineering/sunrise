/**
 * Admin Orchestration — Provider Health (circuit breaker status)
 *
 * GET  /api/v1/admin/orchestration/providers/:id/health — read breaker state
 * POST /api/v1/admin/orchestration/providers/:id/health — reset the breaker
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
import { validatePathParam } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { getClientIP } from '@/lib/security/ip';
import {
  getCircuitBreakerStatusForProvider,
  resetBreakersForProvider,
} from '@/lib/orchestration/llm/circuit-breaker';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';
import { cuidSchema } from '@/lib/validations/common';

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'provider id' });
  const log = await getRouteLogger(request);

  const provider = await prisma.aiProviderConfig.findUnique({ where: { id } });
  if (!provider) throw new NotFoundError(`Provider ${id} not found`);

  const status = getCircuitBreakerStatusForProvider(provider.slug) ?? {
    state: 'closed' as const,
    failureCount: 0,
    openedAt: null,
    config: { failureThreshold: 5, windowMs: 60_000, cooldownMs: 30_000 },
  };

  log.info('Provider health checked', { providerId: id, slug: provider.slug });

  return successResponse({
    providerId: id,
    slug: provider.slug,
    ...status,
  });
});

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const { id: rawId } = await params;
  const id = validatePathParam(rawId, cuidSchema, { label: 'provider id' });
  const clientIP = getClientIP(request);

  const log = await getRouteLogger(request);

  const provider = await prisma.aiProviderConfig.findUnique({ where: { id } });
  if (!provider) throw new NotFoundError(`Provider ${id} not found`);

  resetBreakersForProvider(provider.slug);

  const status = getCircuitBreakerStatusForProvider(provider.slug) ?? {
    state: 'closed' as const,
    failureCount: 0,
    openedAt: null,
    config: { failureThreshold: 5, windowMs: 60_000, cooldownMs: 30_000 },
  };

  log.info('Circuit breaker reset', {
    providerId: id,
    slug: provider.slug,
    adminId: session.user.id,
  });

  logAdminAction({
    userId: session.user.id,
    action: 'provider.health_reset',
    entityType: 'provider',
    entityId: id,
    entityName: provider.name,
    clientIp: clientIP,
  });

  return successResponse({
    providerId: id,
    slug: provider.slug,
    ...status,
  });
});
