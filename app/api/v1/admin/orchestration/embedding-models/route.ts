/**
 * Admin Orchestration — Embedding Models Registry
 *
 * GET /api/v1/admin/orchestration/embedding-models
 *
 * Returns embedding models from the provider models DB table,
 * optionally filtered by schema compatibility, free tier, or local.
 * Falls back to the static registry if the DB query fails.
 *
 * Authentication: Admin role required.
 */

import { z } from 'zod';
import { withAdminAuth } from '@/lib/auth/guards';
import { successResponse } from '@/lib/api/responses';
import { validateQueryParams } from '@/lib/api/validation';
import { adminLimiter, createRateLimitResponse } from '@/lib/security/rate-limit';
import { getClientIP } from '@/lib/security/ip';
import { getEmbeddingModels } from '@/lib/orchestration/llm/embedding-models';

const booleanQueryParam = z
  .enum(['true', 'false'])
  .default('false')
  .transform((v) => v === 'true');

const embeddingModelsQuerySchema = z.object({
  schemaCompatibleOnly: booleanQueryParam,
  hasFreeTier: booleanQueryParam,
  local: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const GET = withAdminAuth(async (request) => {
  const clientIP = getClientIP(request);
  const rateLimit = adminLimiter.check(clientIP);
  if (!rateLimit.success) return createRateLimitResponse(rateLimit);

  const { searchParams } = new URL(request.url);
  const { schemaCompatibleOnly, hasFreeTier, local } = validateQueryParams(
    searchParams,
    embeddingModelsQuerySchema
  );

  let models = await getEmbeddingModels();

  if (schemaCompatibleOnly) {
    models = models.filter((m) => m.schemaCompatible);
  }
  if (hasFreeTier) {
    models = models.filter((m) => m.hasFreeTier);
  }
  if (local !== undefined) {
    models = models.filter((m) => m.local === local);
  }

  return successResponse(models);
});
