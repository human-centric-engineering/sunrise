/**
 * Admin Orchestration — Agent Version Detail
 *
 * GET  /api/v1/admin/orchestration/agents/:id/versions/:versionId
 *   - Returns the full version snapshot (including config at that point).
 *
 * Restore is handled by the /restore sub-route.
 * @see ./restore/route.ts
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { cuidSchema } from '@/lib/validations/common';

function validateIds(rawAgentId: string, rawVersionId: string) {
  const agentParsed = cuidSchema.safeParse(rawAgentId);
  if (!agentParsed.success) {
    throw new ValidationError('Invalid agent id', { id: ['Must be a valid CUID'] });
  }
  const versionParsed = cuidSchema.safeParse(rawVersionId);
  if (!versionParsed.success) {
    throw new ValidationError('Invalid version id', { versionId: ['Must be a valid CUID'] });
  }
  return { agentId: agentParsed.data, versionId: versionParsed.data };
}

export const GET = withAdminAuth<{ id: string; versionId: string }>(
  async (request, _session, { params }) => {
    const clientIP = getClientIP(request);
    const rateLimit = adminLimiter.check(clientIP);
    if (!rateLimit.success) return createRateLimitResponse(rateLimit);

    const { id: rawId, versionId: rawVersionId } = await params;
    const { agentId, versionId } = validateIds(rawId, rawVersionId);

    const version = await prisma.aiAgentVersion.findFirst({
      where: { id: versionId, agentId },
    });
    if (!version) throw new NotFoundError('Version not found');

    return successResponse(version);
  }
);
