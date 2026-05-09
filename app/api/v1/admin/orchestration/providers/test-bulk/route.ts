/**
 * Admin Orchestration — Bulk provider connection test
 *
 * POST /api/v1/admin/orchestration/providers/test-bulk
 *   Body: { providerIds: string[] }
 *
 * Runs `testConnection()` on each requested provider concurrently
 * server-side and returns one result row per id. Replaces the previous
 * client-side N+1 pattern where the providers list fired N parallel
 * `POST /providers/:id/test` calls on mount.
 *
 * Same per-result error sanitisation contract as the single-id endpoint:
 * raw SDK errors are logged server-side but the response only carries
 * `{ ok: false, error: 'connection_failed' }` so the route can't be
 * used as a blind-SSRF port scanner.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { validateRequestBody } from '@/lib/api/validation';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { testProvider } from '@/lib/orchestration/llm/provider-manager';
import { bulkProviderTestSchema } from '@/lib/validations/orchestration';

interface BulkTestResult {
  /** Provider id from the request. */
  id: string;
  /** True when `testConnection()` returned ok. */
  ok: boolean;
  /** Models reported by the provider (empty when ok=false). */
  models: string[];
  /** Stable error code on failure, e.g. `connection_failed`. */
  error?: string;
}

export const POST = withAdminAuth(async (request, session) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { providerIds } = await validateRequestBody(request, bulkProviderTestSchema);

  // Look up all requested providers in a single round trip rather than
  // N point queries. Missing ids drop out — the response just won't
  // include a row for them, mirroring how a single-id 404 looks here.
  const providers = await prisma.aiProviderConfig.findMany({
    where: { id: { in: providerIds } },
    select: { id: true, slug: true },
  });

  // Run upstream tests concurrently. `allSettled` is intentional — we
  // want one bad SDK call to fail in isolation without poisoning the
  // rest of the batch.
  const settled = await Promise.allSettled(
    providers.map(async (p): Promise<BulkTestResult> => {
      try {
        const result = await testProvider(p.slug);
        return { id: p.id, ok: result.ok, models: result.models };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('Bulk provider test threw', {
          providerId: p.id,
          slug: p.slug,
          error: message,
        });
        return { id: p.id, ok: false, models: [], error: 'connection_failed' };
      }
    })
  );

  const results: BulkTestResult[] = settled.map((r, i) => {
    if (r.status === 'fulfilled') return r.value;
    // Defensive — the inner async function already catches everything,
    // so a rejected promise here means something escaped the try/catch
    // (e.g. a logger throw). Sanitise to the same shape so callers get
    // a uniform array.
    return {
      id: providers[i].id,
      ok: false,
      models: [],
      error: 'connection_failed',
    };
  });

  log.info('Bulk provider test', {
    requested: providerIds.length,
    found: providers.length,
    okCount: results.filter((r) => r.ok).length,
    adminId: session.user.id,
  });

  return successResponse({ results });
});
