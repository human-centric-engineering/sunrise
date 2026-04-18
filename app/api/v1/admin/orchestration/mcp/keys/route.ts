/**
 * Admin MCP — API Keys
 *
 * GET  /api/v1/admin/orchestration/mcp/keys — list API keys
 * POST /api/v1/admin/orchestration/mcp/keys — create API key (returns plaintext once)
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse, paginatedResponse } from '@/lib/api/responses';
import { validateRequestBody, validateQueryParams } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { generateApiKey } from '@/lib/orchestration/mcp';
import { createApiKeySchema, listApiKeysQuerySchema } from '@/lib/validations/mcp';

export const GET = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { page, limit, isActive } = validateQueryParams(
    new URL(request.url).searchParams,
    listApiKeysQuerySchema
  );

  const where: Record<string, unknown> = {};
  if (isActive !== undefined) where.isActive = isActive;

  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    prisma.mcpApiKey.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        name: true,
        keyPrefix: true,
        scopes: true,
        isActive: true,
        expiresAt: true,
        lastUsedAt: true,
        rateLimitOverride: true,
        createdBy: true,
        createdAt: true,
        updatedAt: true,
        creator: { select: { name: true, email: true } },
      },
    }),
    prisma.mcpApiKey.count({ where }),
  ]);

  log.info('MCP API keys listed', { count: items.length, total });
  return paginatedResponse(items, { page, limit, total });
});

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, createApiKeySchema);

  const { plaintext, hash, prefix } = generateApiKey();

  const key = await prisma.mcpApiKey.create({
    data: {
      name: body.name,
      keyHash: hash,
      keyPrefix: prefix,
      scopes: body.scopes,
      expiresAt: body.expiresAt ?? null,
      rateLimitOverride: body.rateLimitOverride ?? null,
      createdBy: session.user.id,
    },
  });

  log.info('MCP API key created', {
    adminId: session.user.id,
    keyId: key.id,
    keyPrefix: prefix,
    scopes: body.scopes,
  });

  // Return plaintext once — it cannot be retrieved again
  return successResponse(
    {
      id: key.id,
      name: key.name,
      keyPrefix: key.keyPrefix,
      scopes: key.scopes,
      plaintext,
    },
    undefined,
    { status: 201 }
  );
});
