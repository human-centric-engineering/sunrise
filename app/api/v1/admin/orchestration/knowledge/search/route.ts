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
import { searchKnowledge, type SearchFilters } from '@/lib/orchestration/knowledge/search';
import { resolveAgentDocumentAccess } from '@/lib/orchestration/knowledge/resolveAgentDocumentAccess';
import { knowledgeSearchSchema } from '@/lib/validations/orchestration';

export const POST = withAdminAuth(async (request, _session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const body = await validateRequestBody(request, knowledgeSearchSchema);

  const { query, limit, chunkType, patternNumber, scope, agentId } = body;
  const filters: SearchFilters = { chunkType, patternNumber, scope };

  // Preview-as-agent: route the search through the resolver when `agentId` is
  // supplied so the admin sees what that agent would see. Without it the
  // search runs unfiltered — explicit "global view".
  let agentScope: 'full' | 'restricted' | undefined;
  if (agentId) {
    const access = await resolveAgentDocumentAccess(agentId);
    agentScope = access.mode;
    if (access.mode === 'restricted') {
      filters.documentIds = access.documentIds;
      filters.includeSystemScope = access.includeSystemScope;
    }
  }

  const results = await searchKnowledge(query, filters, limit);

  log.info('Knowledge search completed', {
    query,
    resultCount: results.length,
    agentId,
    agentScope,
  });

  return successResponse({ results, agentScope });
});
