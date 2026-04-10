/**
 * Admin Orchestration — Live per-provider model listing
 *
 * GET /api/v1/admin/orchestration/providers/:id/models
 *
 * Loads the provider row, resolves the instance via `providerManager.getProvider`,
 * then calls `provider.listModels()` live. This is deliberately distinct
 * from `GET /orchestration/models` (which returns the aggregated registry
 * view across every provider): "what does *this* provider say it has"
 * vs. "what do we know about across the ecosystem".
 *
 * Returns 503 if `listModels` throws — the provider is unreachable but
 * the route itself is fine.
 *
 * Authentication: Admin role required.
 */

import { withAdminAuth } from '@/lib/auth/guards';
import { prisma } from '@/lib/db/client';
import { errorResponse, successResponse } from '@/lib/api/responses';
import { NotFoundError, ValidationError } from '@/lib/api/errors';
import { getRouteLogger } from '@/lib/api/context';
import { getProvider } from '@/lib/orchestration/llm/provider-manager';
import { cuidSchema } from '@/lib/validations/common';

export const GET = withAdminAuth<{ id: string }>(async (request, _session, { params }) => {
  const log = await getRouteLogger(request);
  const { id: rawId } = await params;
  const parsed = cuidSchema.safeParse(rawId);
  if (!parsed.success) {
    throw new ValidationError('Invalid provider id', { id: ['Must be a valid CUID'] });
  }
  const id = parsed.data;

  const row = await prisma.aiProviderConfig.findUnique({ where: { id } });
  if (!row) throw new NotFoundError(`Provider ${id} not found`);

  try {
    const provider = await getProvider(row.slug);
    const models = await provider.listModels();
    log.info('Provider models listed', {
      providerId: id,
      slug: row.slug,
      modelCount: models.length,
    });
    return successResponse({ providerId: id, slug: row.slug, models });
  } catch (err) {
    // Raw SDK error is deliberately withheld from the client — in a
    // blind-SSRF context it would act as an exfiltration oracle about
    // the baseUrl target. Log it server-side, return a generic message.
    const message = err instanceof Error ? err.message : String(err);
    log.warn('Provider listModels failed', { providerId: id, slug: row.slug, error: message });
    return errorResponse(`Provider "${row.slug}" is unavailable`, {
      code: 'PROVIDER_UNAVAILABLE',
      status: 503,
    });
  }
});
