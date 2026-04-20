/**
 * Admin MCP — API Key Rotation
 *
 * POST /api/v1/admin/orchestration/mcp/keys/:id/rotate
 *
 * Generates fresh key material for an existing MCP API key.
 * The new plaintext key is returned ONCE in the response body and
 * is never stored. The previous key is immediately invalidated
 * (keyHash is replaced atomically).
 *
 * Body (optional): { expiresAt?: ISO date string | null }
 *
 * Auth: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { generateApiKey } from '@/lib/orchestration/mcp/auth';
import { mcpApiKeyRotateSchema } from '@/lib/validations/mcp';
import { cuidSchema } from '@/lib/validations/common';

const SAFE_SELECT = {
  id: true,
  name: true,
  keyPrefix: true,
  scopes: true,
  isActive: true,
  expiresAt: true,
  lastUsedAt: true,
  rateLimitOverride: true,
  createdAt: true,
  updatedAt: true,
} as const;

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const { id } = await params;
  cuidSchema.parse(id);

  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);

  const existing = await prisma.mcpApiKey.findUnique({ where: { id } });
  if (!existing) throw new NotFoundError('API key not found');

  const body = await validateRequestBody(request, mcpApiKeyRotateSchema);
  const { plaintext, hash, prefix } = generateApiKey();

  const updateData: Record<string, unknown> = {
    keyHash: hash,
    keyPrefix: prefix,
  };
  if (body.expiresAt !== undefined) {
    updateData.expiresAt = body.expiresAt;
  }

  const updated = await prisma.mcpApiKey.update({
    where: { id },
    data: updateData,
    select: SAFE_SELECT,
  });

  log.info('MCP API key rotated', {
    adminId: session.user.id,
    keyId: id,
    previousPrefix: existing.keyPrefix,
    newPrefix: prefix,
  });

  // plaintext is returned once only — never stored or logged
  return successResponse({
    ...updated,
    plaintextKey: plaintext,
  });
});
