/**
 * Admin Orchestration — Knowledge meta-tags
 *
 * GET /api/v1/admin/orchestration/knowledge/meta-tags
 *
 * Returns all distinct category and keyword values used across chunks,
 * with counts of how many chunks and documents reference each value.
 * Used by the upload UI to suggest existing categories and by the
 * meta-tag usage panel to show what's in the knowledge base.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { listMetaTags } from '@/lib/orchestration/knowledge/document-manager';

export const GET = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const metaTags = await listMetaTags();

  return successResponse(metaTags);
});
