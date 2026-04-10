/**
 * Admin Orchestration — Provider connection test
 *
 * POST /api/v1/admin/orchestration/providers/:id/test
 *
 * Loads the `AiProviderConfig` row, calls `providerManager.testProvider(slug)`,
 * and returns `{ ok, models, error? }`. On `ok: false` the endpoint still
 * returns HTTP 200 — the endpoint itself succeeded, the provider just
 * failed. Only 404 / 401 / 403 / 5xx indicate the endpoint itself broke.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { testProvider } from '@/lib/orchestration/llm/provider-manager';
import { cuidSchema } from '@/lib/validations/common';

export const POST = withAdminAuth<{ id: string }>(async (request, session, { params }) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid provider id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const provider = await prisma.aiProviderConfig.findUnique({ where: { id } });
  if (!provider) throw new NotFoundError(`Provider ${id} not found`);

  try {
    const result = await testProvider(provider.slug);
    log.info('Provider tested', {
      providerId: id,
      slug: provider.slug,
      ok: result.ok,
      adminId: session.user.id,
    });
    return successResponse(result);
  } catch (err) {
    // testProvider can throw ProviderError when the config itself is
    // broken (missing API key, unknown provider type, etc). Return the
    // same shape as a failed test rather than a 500 so the UI has one
    // consistent error-rendering path.
    //
    // The raw SDK error is intentionally NOT forwarded to the client: in
    // a blind-SSRF scenario the verbatim fetch error message leaks
    // information about the baseUrl target (connection refused on a
    // private IP vs. TLS error on a public one). Log it server-side
    // for operators, return a generic code to the caller.
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Provider test threw', { providerId: id, slug: provider.slug, error: message });
    return successResponse({
      ok: false,
      models: [],
      error: 'connection_failed',
    });
  }
});
