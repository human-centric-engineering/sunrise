/**
 * Consumer Chat — Validate Invite Token
 *
 * POST /api/v1/chat/agents/:slug/validate-token
 *
 * Checks whether an invite token is valid for the given agent.
 * Returns { valid: true } or { valid: false, reason: "..." }.
 *
 * Authentication: Any authenticated user.
 */

import { z } from 'zod';
import { withAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { ValidationError } from '@/lib/api/errors';
import { chatLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';

const bodySchema = z.object({
  inviteToken: z.string().min(1, 'Invite token is required'),
});

export const POST = withAuth<{ slug: string }>(async (request, _session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = chatLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { slug } = await params;

  const raw: unknown = await request.json();
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    throw new ValidationError('Invalid request body', parsed.error.flatten().fieldErrors);
  }

  const agent = await prisma.aiAgent.findFirst({
    where: { slug, isActive: true },
    select: { id: true, visibility: true },
  });

  if (!agent) {
    return successResponse({ valid: false, reason: 'Agent not found' });
  }

  if (agent.visibility !== 'invite_only') {
    return successResponse({ valid: false, reason: 'Agent does not require an invite token' });
  }

  const token = await prisma.aiAgentInviteToken.findFirst({
    where: {
      agentId: agent.id,
      token: parsed.data.inviteToken,
    },
  });

  if (!token) {
    return successResponse({ valid: false, reason: 'Token not found' });
  }

  if (token.revokedAt) {
    return successResponse({ valid: false, reason: 'Token has been revoked' });
  }

  if (token.expiresAt && token.expiresAt < new Date()) {
    return successResponse({ valid: false, reason: 'Token has expired' });
  }

  if (token.maxUses !== null && token.useCount >= token.maxUses) {
    return successResponse({ valid: false, reason: 'Token has reached its usage limit' });
  }

  return successResponse({ valid: true });
});
