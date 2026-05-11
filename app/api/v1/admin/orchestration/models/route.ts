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
import { prisma } from '@/lib/db/client';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { mergeDbModelsWithRegistry } from '@/lib/orchestration/llm/db-model-adapter';
import {
  getAvailableModels,
  getRegistryFetchedAt,
  refreshFromOpenRouter,
} from '@/lib/orchestration/llm/model-registry';

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

  // Merge operator-curated `AiProviderModel` rows on top of the
  // in-memory registry. Without this step, models like `gpt-5` that
  // live only in the matrix never reach the agent-form Model dropdown.
  // See `lib/orchestration/llm/db-model-adapter.ts` for the rationale
  // and the precedence rules (DB row wins on conflict).
  const [registryModels, dbModels] = await Promise.all([
    Promise.resolve(getAvailableModels()),
    prisma.aiProviderModel.findMany({ where: { isActive: true } }),
  ]);
  const models = mergeDbModelsWithRegistry(registryModels, dbModels);
  const fetchedAt = getRegistryFetchedAt();
  log.info('Models listed', {
    modelCount: models.length,
    registryCount: registryModels.length,
    dbCount: dbModels.length,
    refreshed: refresh,
  });
  return successResponse({
    models,
    refreshed: refresh,
    /** Epoch ms when OpenRouter pricing was last fetched. 0 = static fallback only. */
    fetchedAt,
  });
});
