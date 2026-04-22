/**
 * User API Keys — List + Create
 *
 * GET  /api/v1/user/api-keys — List the current user's API keys
 * POST /api/v1/user/api-keys — Generate a new API key
 *
 * Self-service key management. Keys are scoped (chat, analytics,
 * knowledge, admin) and the raw key is returned only once at creation.
 */

import { withAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ForbiddenError } from '@/lib/api/errors';
import { apiLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { validateRequestBody } from '@/lib/api/validation';
import { createApiKeySchema } from '@/lib/validations/orchestration';
import { generateApiKey, hashApiKey, keyPrefix } from '@/lib/auth/api-keys';

export const GET = withAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = apiLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const keys = await prisma.aiApiKey.findMany({
    where: { userId: session.user.id },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      scopes: true,
      lastUsedAt: true,
      expiresAt: true,
      revokedAt: true,
      createdAt: true,
    },
  });

  return successResponse({ keys });
});

export const POST = withAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = apiLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const body = await validateRequestBody(request, createApiKeySchema);

  if (body.scopes.includes('admin') && session.user.role !== 'ADMIN') {
    throw new ForbiddenError('Admin scope requires admin role');
  }

  const rawKey = generateApiKey();
  const hash = hashApiKey(rawKey);
  const prefix = keyPrefix(rawKey);

  const apiKey = await prisma.aiApiKey.create({
    data: {
      userId: session.user.id,
      name: body.name,
      keyHash: hash,
      keyPrefix: prefix,
      scopes: body.scopes,
      expiresAt: body.expiresAt ? new Date(body.expiresAt) : null,
    },
    select: {
      id: true,
      name: true,
      keyPrefix: true,
      scopes: true,
      expiresAt: true,
      createdAt: true,
    },
  });

  // Return the raw key exactly once — it cannot be retrieved again
  return successResponse(
    {
      key: {
        ...apiKey,
        rawKey,
      },
    },
    undefined,
    { status: 201 }
  );
});
