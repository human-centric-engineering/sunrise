/**
 * Admin Orchestration — Embedding Models Registry
 *
 * GET /api/v1/admin/orchestration/embedding-models
 *
 * Returns a curated list of embedding models from the static registry,
 * optionally filtered by schema compatibility, free tier, or local.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { filterEmbeddingModels } from '@/lib/orchestration/llm/embedding-models';

export const GET = withAdminAuth((request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const url = new URL(request.url);
  const schemaCompatibleOnly = url.searchParams.get('schemaCompatibleOnly') === 'true';
  const hasFreeTier = url.searchParams.get('hasFreeTier') === 'true';
  const localParam = url.searchParams.get('local');
  const local = localParam === null ? undefined : localParam === 'true';

  const models = filterEmbeddingModels({ schemaCompatibleOnly, hasFreeTier, local });

  return successResponse(models);
});
