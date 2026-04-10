/**
 * Admin Orchestration — Aggregated model catalogue
 *
 * GET /api/v1/admin/orchestration/models
 * GET /api/v1/admin/orchestration/models?refresh=true
 *
 * Returns the merged model registry view (static fallback + OpenRouter
 * pricing + any provider-discovered entries). The `?refresh=true` path
 * forces `refreshFromOpenRouter({ force: true })` before reading, and
 * is rate-limited because it makes an outbound network call.
 *
 * Distinct from `/providers/:id/models` (which calls `listModels` live
 * on a single provider).
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { getAvailableModels, refreshFromOpenRouter } from '@/lib/orchestration/llm/model-registry';

export const GET = withAdminAuth(async (request, _session) => {
  const log = await getRouteLogger(request);
  const { searchParams } = new URL(request.url);
  const refresh = searchParams.get('refresh') === 'true';

  if (refresh) {
    const clientIP = getClientIP(request);
    const rateLimit = adminLimiter.check(clientIP);
    if (!rateLimit.success) return createRateLimitResponse(rateLimit);
    await refreshFromOpenRouter({ force: true });
    log.info('Model registry refresh forced');
  }

  const models = getAvailableModels();
  log.info('Models listed', { modelCount: models.length, refreshed: refresh });
  return successResponse({ models, refreshed: refresh });
});
