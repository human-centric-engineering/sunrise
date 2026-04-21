/**
 * Admin MCP — Session by ID
 *
 * DELETE /api/v1/admin/orchestration/mcp/sessions/:id — force-terminate session
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { getMcpSessionManager } from '@/lib/orchestration/mcp';

export const DELETE = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const { id } = await params;

  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const sessionManager = getMcpSessionManager();
  const destroyed = sessionManager.destroySession(id);

  if (!destroyed) throw new NotFoundError('Session not found');

  log.info('MCP session terminated', {
    adminId: session.user.id,
    sessionId: id,
  });

  return successResponse({ id, destroyed: true });
});
