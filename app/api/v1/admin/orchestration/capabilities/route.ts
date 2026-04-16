/**
 * Admin Orchestration — Capabilities (list + create)
 *
 * GET  /api/v1/admin/orchestration/capabilities  — paginated list with filters
 * POST /api/v1/admin/orchestration/capabilities  — create a new capability
 *
 * On successful create, `capabilityDispatcher.clearCache()` is called so
 * the dispatcher picks up the new registration on its next dispatch.
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
import { capabilityDispatcher } from '@/lib/orchestration/capabilities';
import {
  createCapabilitySchema,
  listCapabilitiesQuerySchema,
} from '@/lib/validations/orchestration';

export const GET = withAdminAuth(async (request, _session) => {
  const log = await getRouteLogger(request);

  const { searchParams } = new URL(request.url);
  const { page, limit, isActive, category, executionType, q } = validateQueryParams(
    searchParams,
    listCapabilitiesQuerySchema
  );
  const skip = (page - 1) * limit;

  const where: Prisma.AiCapabilityWhereInput = {};
  if (isActive !== undefined) where.isActive = isActive;
  if (category) where.category = category;
  if (executionType) where.executionType = executionType;
  if (q) {
    where.OR = [
      { name: { contains: q, mode: 'insensitive' } },
      { slug: { contains: q, mode: 'insensitive' } },
      { description: { contains: q, mode: 'insensitive' } },
    ];
  }

  const [rawCapabilities, total] = await Promise.all([
    prisma.aiCapability.findMany({
      where,
      orderBy: { category: 'asc' },
      skip,
      take: limit,
      include: {
        agents: {
          include: {
            agent: { select: { id: true, name: true, slug: true, isActive: true } },
          },
        },
      },
    }),
    prisma.aiCapability.count({ where }),
  ]);

  const capabilities = rawCapabilities.map(({ agents: links, ...rest }) => ({
    ...rest,
    _agents: links.map((l) => l.agent),
  }));

  log.info('Capabilities listed', { count: capabilities.length, total, page, limit });

  return paginatedResponse(capabilities, { page, limit, total });
});

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, createCapabilitySchema);

  try {
    const capability = await prisma.aiCapability.create({
      data: {
        name: body.name,
        slug: body.slug,
        description: body.description,
        category: body.category,
        functionDefinition: body.functionDefinition as unknown as Prisma.InputJsonValue,
        executionType: body.executionType,
        executionHandler: body.executionHandler,
        executionConfig: (body.executionConfig ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        requiresApproval: body.requiresApproval,
        approvalTimeoutMs: body.approvalTimeoutMs ?? null,
        rateLimit: body.rateLimit ?? null,
        isActive: body.isActive,
        metadata: (body.metadata ?? Prisma.JsonNull) as Prisma.InputJsonValue,
      },
    });

    capabilityDispatcher.clearCache();

    log.info('Capability created', {
      capabilityId: capability.id,
      slug: capability.slug,
      adminId: session.user.id,
    });

    return successResponse(capability, undefined, { status: 201 });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new ConflictError(`Capability with slug '${body.slug}' already exists`);
    }
    throw err;
  }
});
