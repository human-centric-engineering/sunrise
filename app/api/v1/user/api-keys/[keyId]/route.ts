/**
 * User API Key — Revoke
 *
 * DELETE /api/v1/user/api-keys/:keyId
 *
 * Revokes an API key by setting `revokedAt`. The key record is
 * preserved for audit. Users can only revoke their own keys.
 */

import { withAuth } from '@/lib/auth/guards';
import type { AuthSession } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { apiLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';

type Params = { keyId: string };

export const DELETE = withAuth<Params>(async (request, session: AuthSession, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = apiLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { keyId: rawKeyId } = await params;
  const parsed = cuidSchema.safeParse(rawKeyId);
  if (!parsed.success)
    throw new ValidationError('Invalid key id', { keyId: ['Must be a valid CUID'] });

  const apiKey = await prisma.aiApiKey.findFirst({
    where: {
      id: parsed.data,
      userId: session.user.id,
    },
  });
  if (!apiKey) throw new NotFoundError('API key not found');

  if (apiKey.revokedAt) {
    return successResponse({ message: 'API key already revoked' });
  }

  await prisma.aiApiKey.update({
    where: { id: apiKey.id },
    data: { revokedAt: new Date() },
  });

  return successResponse({ message: 'API key revoked' });
});
