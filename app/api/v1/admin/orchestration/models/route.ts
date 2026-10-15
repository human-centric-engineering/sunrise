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
 * Org-tier (§111 t-812): an org admin reads the catalogue, which the costs
 * page's pricing and the dashboard's trend chart need (ruling 3: shared config
 * is read-open). Any viewer's read may warm a stale registry from OpenRouter,
 * as any page load or chat turn may: the registry's own TTL and backoff bound
 * that to one outbound call per 24h (5 min after a failure), whoever triggers
 * it. `?refresh=true` skips those bounds — an outbound call on demand, on the
 * install's behalf — so forcing a refresh stays a platform admin's.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { administersPlatform } from '@/lib/auth/admin-viewer';
import { ForbiddenError } from '@/lib/api/errors';
import { successResponse } from '@/lib/api/responses';
import { getRouteLogger } from '@/lib/api/context';
import { prisma } from '@/lib/db/client';
import { mergeDbModelsWithRegistry } from '@/lib/orchestration/llm/db-model-adapter';
import {
  getAvailableModels,
  getRegistryFetchedAt,
  refreshFromOpenRouter,
} from '@/lib/orchestration/llm/model-registry';

export const GET = withAdminAuth(
  async (request, session) => {
    const log = await getRouteLogger(request);
    const { searchParams } = new URL(request.url);
    const refresh = searchParams.get('refresh') === 'true';

    if (refresh && !(await administersPlatform(session.principal))) {
      throw new ForbiddenError('Only a platform admin may force a model registry refresh');
    }

    if (refresh) {
      await refreshFromOpenRouter({ force: true });
      log.info('Model registry refresh forced');
    } else {
      // Warm this handler's own registry instance. In Next.js's per-route
      // bundling, `model-registry.ts` can be duplicated between the page's
      // module graph and this route handler's, so a `refreshFromOpenRouter()`
      // call upstream on the server-component side may not populate the
      // instance read here. The TTL/backoff inside the helper makes this a
      // no-op on warm hits (24h success TTL, 5-min failure backoff).
      await refreshFromOpenRouter();
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
  },
  {
    tier: 'org',
    ownership: {
      decidedBy: 'nothing',
      because:
        "Shared configuration every org reads (the model catalogue and its pricing); it holds nobody's personal rows.",
    },
  }
);
