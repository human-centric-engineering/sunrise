/**
 * Admin MCP — Sessions
 *
 * GET /api/v1/admin/orchestration/mcp/sessions — list active in-memory sessions
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { getMcpSessionManager } from '@/lib/orchestration/mcp';

export const GET = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const sessions = getMcpSessionManager().getActiveSessions();

  log.info('MCP sessions listed', { count: sessions.length });
  return successResponse(sessions);
});
