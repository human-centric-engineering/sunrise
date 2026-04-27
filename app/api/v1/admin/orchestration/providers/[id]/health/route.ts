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
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { getBreaker, getCircuitBreakerStatus } from '@/lib/orchestration/llm/circuit-breaker';
import { cuidSchema } from '@/lib/validations/common';

function parseProviderId(raw: string): string {
  const parsed = cuidSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid provider id', { id: ['Must be a valid CUID'] });
  }
  return parsed.data;
}

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const { id: rawId } = await params;
  const id = parseProviderId(rawId);
  const log = await getRouteLogger(request);

  const provider = await prisma.aiProviderConfig.findUnique({ where: { id } });
  if (!provider) throw new NotFoundError(`Provider ${id} not found`);

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
  const { id: rawId } = await params;
  const id = parseProviderId(rawId);
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);

  const provider = await prisma.aiProviderConfig.findUnique({ where: { id } });
  if (!provider) throw new NotFoundError(`Provider ${id} not found`);

  getBreaker(provider.slug).reset();

  const status = getCircuitBreakerStatus(provider.slug) ?? {
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

  return successResponse({
    providerId: id,
    slug: provider.slug,
    ...status,
  });
});
