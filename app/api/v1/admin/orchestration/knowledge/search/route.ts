/**
 * Admin Orchestration — Knowledge Search
 *
 * POST /api/v1/admin/orchestration/knowledge/search
 *
 * POST (not GET) because filter payloads can contain arbitrary text
 * that shouldn't end up in access logs or URL bars.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { searchKnowledge } from '@/lib/orchestration/knowledge/search';
import { knowledgeSearchSchema } from '@/lib/validations/orchestration';

export const POST = withAdminAuth(async (request, _session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, knowledgeSearchSchema);

  const { query, limit, chunkType, patternNumber, category, scope } = body;
  const filters = { chunkType, patternNumber, category, scope };

  const results = await searchKnowledge(query, filters, limit);

  log.info('Knowledge search completed', { query, resultCount: results.length });

  return successResponse({ results });
});
