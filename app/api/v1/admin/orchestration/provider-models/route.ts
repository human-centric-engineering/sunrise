/**
 * Admin Orchestration — Provider Models (list + create)
 *
 * GET  /api/v1/admin/orchestration/provider-models — paginated list
 *      with optional `configuredProvider` enrichment from AiProviderConfig.
 *      Supports filtering by capability, providerSlug, tierRole, isActive, q.
 * POST /api/v1/admin/orchestration/provider-models — create a new model entry.
 *      Admin-created models are marked `isDefault: false`.
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
import { adminLimiter, apiLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { invalidateModelCache } from '@/lib/orchestration/llm/provider-selector';
import {
  listProviderModelsQuerySchema,
  createProviderModelSchema,
} from '@/lib/validations/orchestration';

export const GET = withAdminAuth(async (request, _session) => {
  const clientIP = getClientIP(request);
  const rateLimit = apiLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);

  const { searchParams } = new URL(request.url);
  const { page, limit, isActive, tierRole, capability, providerSlug, q } = validateQueryParams(
    searchParams,
    listProviderModelsQuerySchema
  );
  const skip = (page - 1) * limit;

  const where: Prisma.AiProviderModelWhereInput = {};
  if (isActive !== undefined) where.isActive = isActive;
  if (tierRole) where.tierRole = tierRole;
  if (providerSlug) where.providerSlug = providerSlug;
  if (capability) where.capabilities = { has: capability };
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { slug: { contains: q, mode: 'insensitive' } },
      { providerSlug: { contains: q, mode: 'insensitive' } },
      { modelId: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
    ];
  }

  const [rows, total, providerConfigs] = await Promise.all([
    prisma.aiProviderModel.findMany({
      where,
      orderBy: [{ providerSlug: 'asc' }, { name: 'asc' }],
      skip,
      take: limit,
    }),
    prisma.aiProviderModel.count({ where }),
    // Look up which providers have a matching AiProviderConfig
    prisma.aiProviderConfig.findMany({
      select: { slug: true, isActive: true },
    }),
  ]);

  const configBySlug = new Map(providerConfigs.map((c) => [c.slug, c]));

  const data = rows.map((model) => {
    const config = configBySlug.get(model.providerSlug);
    return {
      ...model,
      configured: !!config,
      configuredActive: config?.isActive ?? false,
    };
  });

  log.info('Provider models listed', { count: rows.length, total, page, limit });

  return paginatedResponse(data, { page, limit, total });
});

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, createProviderModelSchema);

  try {
    const model = await prisma.aiProviderModel.create({
      data: {
        name: body.name,
        slug: body.slug,
        providerSlug: body.providerSlug,
        modelId: body.modelId,
        description: body.description,
        capabilities: body.capabilities,
        tierRole: body.tierRole,
        reasoningDepth: body.reasoningDepth,
        latency: body.latency,
        costEfficiency: body.costEfficiency,
        contextLength: body.contextLength,
        toolUse: body.toolUse,
        bestRole: body.bestRole,
        dimensions: body.dimensions ?? null,
        schemaCompatible: body.schemaCompatible ?? null,
        costPerMillionTokens: body.costPerMillionTokens ?? null,
        hasFreeTier: body.hasFreeTier ?? null,
        local: body.local,
        quality: body.quality ?? null,
        strengths: body.strengths ?? null,
        setup: body.setup ?? null,
        isDefault: false, // admin-created models are never re-seedable
        isActive: body.isActive,
        metadata: (body.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        createdBy: session.user.id,
      },
    });

    invalidateModelCache();

    log.info('Provider model created', {
      modelId: model.id,
      slug: model.slug,
      adminId: session.user.id,
    });

    return successResponse(model, undefined, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError(`Provider model with slug '${body.slug}' already exists`);
    }
    throw err;
  }
});
