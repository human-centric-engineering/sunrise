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
import { resolveInviteToken, type InviteTokenRefusal } from '@/lib/orchestration/invite-tokens';

const bodySchema = z.object({
  inviteToken: z.string().min(1, 'Invite token is required'),
});

/** The widget's copy for each refusal. A token from another org is not found. */
const INVITE_REASONS: Record<InviteTokenRefusal, string> = {
  'not-found': 'Token not found',
  'wrong-org': 'Token not found',
  revoked: 'Token has been revoked',
  expired: 'Token has expired',
  exhausted: 'Token has reached its usage limit',
};

export const POST = withAuth<{ slug: string }>(
  async (request, _session, { params }) => {
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

    // Read-only: the same resolver the stream route consumes a use through,
    // asked without spending one. A token from another org is "not found".
    const outcome = await resolveInviteToken(agent.id, parsed.data.inviteToken);
    if (!outcome.ok) {
      return successResponse({ valid: false, reason: INVITE_REASONS[outcome.reason] });
    }

    return successResponse({ valid: true });
  },
  {
    // Ownership: this route makes no ownership decision — see RouteOwnership in lib/auth/guards.ts.
    ownership: {
      decidedBy: 'nothing',
      because:
        "Resolves an invite token by the token's own value. The token is the credential, and neither it nor the agent is owned by the caller.",
    },
  }
);
