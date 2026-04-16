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
import { successResponse, errorResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { getBreaker, getCircuitBreakerStatus } from '@/lib/orchestration/llm/circuit-breaker';

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const { id } = await params;
  const log = await getRouteLogger(request);

  const provider = await prisma.aiProviderConfig.findUnique({ where: { id } });
  if (!provider) {
    return errorResponse('Provider not found', { code: 'NOT_FOUND', status: 404 });
  }

  const status = getCircuitBreakerStatus(provider.slug) ?? {
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
  const { id } = await params;
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);

  const provider = await prisma.aiProviderConfig.findUnique({ where: { id } });
  if (!provider) {
    return errorResponse('Provider not found', { code: 'NOT_FOUND', status: 404 });
  }

  getBreaker(provider.slug).reset();

  const status = getCircuitBreakerStatus(provider.slug)!;

  log.info('Circuit breaker reset', {
    providerId: id,
    slug: provider.slug,
    adminId: session.user.id,
  });

  return successResponse({
    providerId: id,
    slug: provider.slug,
    ...status,
  });
});
