/**
 * Admin — Single Invite Token (revoke)
 *
 * DELETE /api/v1/admin/orchestration/agents/:id/invite-tokens/:tokenId
 *
 * Revokes an invite token by setting `revokedAt`. Soft-delete — the
 * token record is preserved for audit.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';
import { logAdminAction } from '@/lib/orchestration/audit/admin-audit-logger';

type Params = { id: string; tokenId: string };

export const DELETE = withAdminAuth<Params>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { id: rawAgentId, tokenId: rawTokenId } = await params;

  const agentId = cuidSchema.safeParse(rawAgentId);
  if (!agentId.success)
    throw new ValidationError('Invalid agent id', { id: ['Must be a valid CUID'] });

  const tokenId = cuidSchema.safeParse(rawTokenId);
  if (!tokenId.success)
    throw new ValidationError('Invalid token id', { tokenId: ['Must be a valid CUID'] });

  const token = await prisma.aiAgentInviteToken.findFirst({
    where: { id: tokenId.data, agentId: agentId.data },
  });
  if (!token) throw new NotFoundError('Invite token not found');

  if (token.revokedAt) {
    return successResponse({ message: 'Token already revoked' });
  }

  await prisma.aiAgentInviteToken.update({
    where: { id: token.id },
    data: { revokedAt: new Date() },
  });

  logAdminAction({
    userId: session.user.id,
    action: 'agent.invite_token_revoke',
    entityType: 'agent',
    entityId: agentId.data,
    metadata: { tokenId: tokenId.data, label: token.label },
    clientIp: clientIP,
  });

  return successResponse({ message: 'Token revoked' });
});
