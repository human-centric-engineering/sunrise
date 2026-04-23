/**
 * Admin Orchestration — Providers (list + create)
 *
 * GET  /api/v1/admin/orchestration/providers — paginated list. Every row
 *      is hydrated with `apiKeyPresent: boolean` via `listProvidersWithStatus`.
 *      The env var *value* is NEVER returned or logged.
 * POST /api/v1/admin/orchestration/providers — create a new provider row.
 *
 * Authentication: Admin role required.
 */

import { Prisma } from '@prisma/client';
import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { paginatedResponse, successResponse } from '@/lib/api/responses';
import { ConflictError } from '@/lib/api/errors';
import { validateQueryParams, validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import {
  isApiKeyEnvVarSet,
  clearCache as clearProviderCache,
} from '@/lib/orchestration/llm/provider-manager';
import { getCircuitBreakerStatus } from '@/lib/orchestration/llm/circuit-breaker';
import { listProvidersQuerySchema, providerConfigSchema } from '@/lib/validations/orchestration';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

export const GET = withAdminAuth(async (request, _session) => {
  const log = await getRouteLogger(request);

  const { searchParams } = new URL(request.url);
  const { page, limit, isActive, providerType, isLocal, q } = validateQueryParams(
    searchParams,
    listProvidersQuerySchema
  );
  const skip = (page - 1) * limit;

  const where: Prisma.AiProviderConfigWhereInput = {};
  if (isActive !== undefined) where.isActive = isActive;
  if (providerType) where.providerType = providerType;
  if (isLocal !== undefined) where.isLocal = isLocal;
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { slug: { contains: q, mode: 'insensitive' } },
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.aiProviderConfig.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take: limit,
    }),
    prisma.aiProviderConfig.count({ where }),
  ]);

  const data = rows.map((config) => ({
    ...config,
    apiKeyPresent: isApiKeyEnvVarSet(config.apiKeyEnvVar),
    circuitBreaker: getCircuitBreakerStatus(config.slug) ?? {
      state: 'closed' as const,
      failureCount: 0,
    },
  }));

  log.info('Providers listed', { count: rows.length, total, page, limit });

  return paginatedResponse(data, { page, limit, total });
});

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, providerConfigSchema);

  try {
    const provider = await prisma.aiProviderConfig.create({
      data: {
        name: body.name,
        slug: body.slug,
        providerType: body.providerType,
        baseUrl: body.baseUrl ?? null,
        apiKeyEnvVar: body.apiKeyEnvVar ?? null,
        isLocal: body.isLocal,
        isActive: body.isActive,
        metadata: (body.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        timeoutMs: body.timeoutMs ?? null,
        maxRetries: body.maxRetries ?? null,
        createdBy: session.user.id,
      },
    });

    clearProviderCache(provider.slug);

    log.info('Provider created', {
      providerId: provider.id,
      slug: provider.slug,
      adminId: session.user.id,
    });

    logAdminAction({
      userId: session.user.id,
      action: 'provider.create',
      entityType: 'provider',
      entityId: provider.id,
      entityName: provider.name,
      clientIp: clientIP,
    });

    return successResponse(
      { ...provider, apiKeyPresent: isApiKeyEnvVarSet(provider.apiKeyEnvVar) },
      undefined,
      { status: 201 }
    );
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError(
        `Provider with slug '${body.slug}' or name '${body.name}' already exists`
      );
    }
    throw err;
  }
});
