/**
 * Admin Orchestration — Pattern list
 *
 * GET /api/v1/admin/orchestration/knowledge/patterns
 *
 * Returns a summary of every distinct pattern in the knowledge base,
 * suitable for the pattern explorer card grid.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { listPatterns } from '@/lib/orchestration/knowledge/search';

export const GET = withAdminAuth(async (request) => {
  const log = await getRouteLogger(request);

  const patterns = await listPatterns();

  log.info('Pattern list fetched', { count: patterns.length });

  return successResponse(patterns);
});
